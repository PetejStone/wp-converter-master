import { createHash } from "node:crypto";
import type { FormField, FormVariant } from "../parse";

// Output of buildCf7Forms — one entry per FormVariant. The WXR builder
// emits a wpcf7_contact_form post per entry; templates.ts swaps each
// Scorpion contact form with [contact-form-7 id="<hash>" …] by looking
// the variant fingerprint up in formIdToCf7Lookup.
export interface Cf7Form {
  postId: number;
  slug: string;
  title: string;
  fingerprint: string;
  // Stable lowercase-hex identifier emitted as the CF7 `_hash` postmeta and
  // referenced as the shortcode `id`. CF7 (5.8+) resolves
  // [contact-form-7 id="<hash>"] by REGEXP-matching this meta — see
  // wpcf7_get_contact_form_by_hash(). That match survives the WordPress
  // Importer reassigning post_ids on a non-empty target DB, unlike a numeric
  // post id, and can't collide with a pre-existing form that happens to share
  // a title. Must satisfy CF7's /^[0-9a-f]{7,}$/ validator; a sha256 hex
  // digest of the variant fingerprint does, and is deterministic per form.
  hash: string;
  formTagMarkup: string;
  mailSerialized: string;
  // Auto-responder ("Mail (2)") — sends a thank-you back to the submitter.
  // Only emitted when the form has an email field we can address; null
  // otherwise (CF7 treats a missing _mail_2 as inactive).
  mail2Serialized: string | null;
  localeSerialized: string;
}

export interface BuildCf7Args {
  variants: FormVariant[];
  basePostId: number;
  adminEmail?: string;
  siteTitle?: string;
}

export function buildCf7Forms(args: BuildCf7Args): Cf7Form[] {
  const recipient = args.adminEmail ?? "admin@example.com";
  const fromSender = `${args.siteTitle ?? "Site"} <wordpress@example.com>`;

  return args.variants.map((variant, i) => {
    const postId = args.basePostId + i;
    const slug = `contact-form-${i + 1}`;
    const title = `Contact Form ${i + 1}`;
    const usableFields = dropJunkFields(variant.fields);
    const named = nameFields(usableFields);
    const formTagMarkup = buildFormTagMarkup(
      named,
      variant.submitText ?? "Submit",
    );
    const attachments = buildAttachmentsList(named);
    const mailSerialized = buildMailSerialized({
      recipient,
      sender: fromSender,
      subject: `${args.siteTitle ?? "Site"} form submission`,
      fields: named,
      attachments,
    });
    // If the form has an email field we can address, ship an active
    // auto-responder that thanks the submitter and echoes their inputs.
    // Otherwise leave Mail (2) inactive — better than emailing a literal
    // "[your-email]" string to nowhere.
    const emailField = named.find((nf) => nf.field.inputType === "email");
    const mail2Serialized = emailField
      ? buildMail2Serialized({
          submitterField: emailField.cf7Name,
          sender: fromSender,
          siteTitle: args.siteTitle ?? "Site",
          fields: named,
        })
      : null;

    return {
      postId,
      slug,
      title,
      fingerprint: variant.fingerprint,
      // Deterministic per-variant hex hash → CF7 `_hash` + shortcode id.
      hash: createHash("sha256").update(variant.fingerprint).digest("hex"),
      formTagMarkup,
      mailSerialized,
      mail2Serialized,
      localeSerialized: phpSerialize("en_US"),
    };
  });
}

// Skip Scorpion markup artifacts — checkbox/radio fields that lack a group
// label AND whose only option is the value attribute "on". These come from
// privacy-toggle / consent inputs that have their visible label rendered
// outside the form repeater, so the extractor never pairs them up and they
// surface as nonsense form tags like [checkbox* field-6 "on"]. A real
// single-option checkbox would have a meaningful label or option text and
// passes through.
function dropJunkFields(fields: FormField[]): FormField[] {
  return fields.filter((f) => {
    if (f.tag !== "input") return true;
    if (f.inputType !== "checkbox" && f.inputType !== "radio") return true;
    if (f.label) return true;
    const opts = f.options ?? [];
    if (opts.length === 0) return false;
    return opts.some((o) => o.label && o.label !== "on");
  });
}

interface NamedField {
  field: FormField;
  cf7Name: string;
}

function nameFields(fields: FormField[]): NamedField[] {
  const used = new Set<string>();
  const out: NamedField[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const base = slugifyForCf7(
      f.label || f.placeholder || f.name || `field-${i + 1}`,
    );
    let name = base || `field-${i + 1}`;
    let n = 2;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    out.push({ field: f, cf7Name: name });
  }
  return out;
}

function buildFormTagMarkup(
  fields: NamedField[],
  submitText: string,
): string {
  const lines: string[] = [];
  for (const nf of fields) {
    const tag = buildFieldTag(nf);
    if (!tag) continue;
    const labelText = nf.field.label ?? "";
    if (labelText) {
      const reqSuffix = nf.field.required ? " (required)" : "";
      lines.push(`<label>${escapeHtml(labelText)}${reqSuffix}\n${tag}</label>`);
    } else {
      lines.push(tag);
    }
  }
  lines.push("");
  lines.push(`[submit "${escapeQuotes(submitText)}"]`);
  return lines.join("\n\n");
}

function buildFieldTag(nf: NamedField): string | null {
  const { field, cf7Name } = nf;
  const required = field.required ? "*" : "";

  if (field.tag === "textarea") {
    return `[textarea${required} ${cf7Name}${placeholderModifier(field)}${lengthModifiers(field)}]`;
  }

  if (field.tag === "select") {
    const opts = (field.options ?? [])
      .map((o) => `"${escapeQuotes(o.label)}"`)
      .join(" ");
    const multiple = field.multiple ? " multiple" : "";
    const blank = " include_blank";
    return `[select${required} ${cf7Name}${multiple}${blank} ${opts}]`;
  }

  if (field.tag === "input") {
    const type = (field.inputType ?? "text").toLowerCase();

    if (type === "radio" || type === "checkbox") {
      const opts = (field.options ?? [])
        .map((o) => `"${escapeQuotes(o.label || o.value)}"`)
        .filter((s) => s !== '""')
        .join(" ");
      if (!opts) return null;
      // use_label_element wraps each option in its own <label> for a11y;
      // matches Scorpion's typical rendering more closely.
      const reqMark = type === "radio" ? "" : required; // CF7 disallows [radio*]
      return `[${type}${reqMark} ${cf7Name} use_label_element ${opts}]`;
    }

    if (type === "file") {
      const accept = field.accept ? ` filetypes:${normalizeAccept(field.accept)}` : "";
      return `[file${required} ${cf7Name}${accept}]`;
    }

    if (type === "number" || type === "range") {
      const range = numberRangeModifier(field);
      return `[number${required} ${cf7Name}${range}${placeholderModifier(field)}]`;
    }

    if (type === "date" || type === "month" || type === "time" || type === "week") {
      // CF7 only ships [date]; the others fall back to it visually.
      return `[date${required} ${cf7Name}${placeholderModifier(field)}]`;
    }

    // Patterns + tel placeholder are injected at render time by a
    // wpcf7_form_elements filter in functions.php (CF7's form-tag option
    // parser chokes on regex special chars, so we add the pattern attr
    // post-render). Kept simple here.
    if (
      type === "email" ||
      type === "tel" ||
      type === "url" ||
      type === "password"
    ) {
      return `[${type}${required} ${cf7Name}${placeholderModifier(field)}${lengthModifiers(field)}]`;
    }

    // text + anything else falls back to text.
    return `[text${required} ${cf7Name}${placeholderModifier(field)}${lengthModifiers(field)}]`;
  }

  return null;
}

function placeholderModifier(field: FormField): string {
  if (!field.placeholder) return "";
  return ` placeholder "${escapeQuotes(field.placeholder)}"`;
}

function lengthModifiers(field: FormField): string {
  const parts: string[] = [];
  if (field.minlength) parts.push(`minlength:${field.minlength}`);
  if (field.maxlength) parts.push(`maxlength:${field.maxlength}`);
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

function numberRangeModifier(field: FormField): string {
  const parts: string[] = [];
  if (field.min !== undefined) parts.push(`min:${field.min}`);
  if (field.max !== undefined) parts.push(`max:${field.max}`);
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

// CF7's filetypes modifier is a pipe-separated list of file *extensions* —
// it builds a server-side regex `/\.(jpg|pdf|...)$/i` to validate uploads.
// Browser `accept` values are a mixed bag: dotted extensions (".pdf"),
// specific MIME types ("application/pdf"), and MIME wildcards ("image/*").
// A naive strip of the MIME prefix turns "image/*" into a literal "*"
// which lands in CF7's regex as `/\.(*|pdf|…)$/i` — invalid (`*` quantifier
// with nothing to repeat) and PHP rejects the whole pattern, causing every
// upload validation to error out. Resolve each entry to concrete extensions
// and drop anything that can't be mapped.
function normalizeAccept(accept: string): string {
  const tokens = new Set<string>();
  for (const raw of accept.split(",")) {
    const s = raw.trim().toLowerCase();
    if (s === "") continue;

    const wildcard = MIME_WILDCARD_EXTENSIONS[s];
    if (wildcard) {
      wildcard.forEach((e) => tokens.add(e));
      continue;
    }
    const specific = MIME_TO_EXTENSIONS[s];
    if (specific) {
      specific.forEach((e) => tokens.add(e));
      continue;
    }
    const ext = s.match(/^\.?([a-z0-9]+)$/);
    if (ext) {
      tokens.add(ext[1]);
      continue;
    }
    // Unknown MIME ("application/octet-stream", "foo/bar"): skip rather
    // than emit something CF7 can't parse.
  }
  return [...tokens].join("|");
}

const MIME_WILDCARD_EXTENSIONS: Record<string, string[]> = {
  "image/*": ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg"],
  "video/*": ["mp4", "mov", "webm", "avi", "mkv"],
  "audio/*": ["mp3", "wav", "ogg", "m4a", "aac"],
};

const MIME_TO_EXTENSIONS: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/zip": ["zip"],
};

// CF7 stores _mail as a PHP-serialized associative array. We emit a
// sensible default; admins customise per-form in wp-admin → Contact.
function buildMailSerialized(args: {
  recipient: string;
  sender: string;
  subject: string;
  fields: NamedField[];
  attachments: string;
}): string {
  const bodyLines = ["A form on the website was submitted.", ""];
  for (const nf of args.fields) {
    const label = nf.field.label || nf.cf7Name;
    bodyLines.push(`${label}: [${nf.cf7Name}]`);
  }
  const body = bodyLines.join("\n");

  const emailField = args.fields.find(
    (nf) => nf.field.inputType === "email",
  );
  const replyTo = emailField ? `Reply-To: [${emailField.cf7Name}]` : "";

  return phpSerialize({
    active: true,
    subject: args.subject,
    sender: args.sender,
    recipient: args.recipient,
    body,
    additional_headers: replyTo,
    attachments: args.attachments,
    use_html: false,
    exclude_blank: false,
  });
}

// CF7's `_mail.attachments` is a newline-separated list of form-tag refs
// (e.g. `[resume]\n[cover_letter]`). When empty CF7 sends the email with
// no attachments even if the form has [file] inputs and the user uploaded
// a file — the upload is validated and stored in CF7's temp dir but never
// reaches PHPMailer. We populate this from every named file field so the
// admin notification email carries the submitted file(s).
function buildAttachmentsList(fields: NamedField[]): string {
  return fields
    .filter((nf) => nf.field.tag === "input" && nf.field.inputType === "file")
    .map((nf) => `[${nf.cf7Name}]`)
    .join("\n");
}

// CF7's Mail (2) auto-responder — the email the *submitter* receives.
// Recipient is the email field tag (e.g. `[email]`) so CF7 substitutes
// whatever the user typed. Body echoes the fields they submitted as a
// receipt-of-submission. Subject defaults to "Thank you for contacting
// <SiteTitle>" — admins can edit per-form in wp-admin → Contact.
function buildMail2Serialized(args: {
  submitterField: string;
  sender: string;
  siteTitle: string;
  fields: NamedField[];
}): string {
  const bodyLines = [
    `Hi [${args.submitterField}],`,
    "",
    `Thanks for reaching out to ${args.siteTitle} — we've received your message and will follow up shortly. For reference, here's what you sent:`,
    "",
  ];
  for (const nf of args.fields) {
    const label = nf.field.label || nf.cf7Name;
    bodyLines.push(`${label}: [${nf.cf7Name}]`);
  }
  bodyLines.push("");
  bodyLines.push(`— ${args.siteTitle}`);
  const body = bodyLines.join("\n");

  return phpSerialize({
    active: true,
    subject: `Thank you for contacting ${args.siteTitle}`,
    sender: args.sender,
    recipient: `[${args.submitterField}]`,
    body,
    additional_headers: "",
    attachments: "",
    use_html: false,
    exclude_blank: false,
  });
}

// PHP serialize() output for the subset of types we use: strings,
// integers, booleans, plain objects (assoc arrays). Matches PHP's
// `serialize()` byte-for-byte for these inputs — CF7's `unserialize()`
// reads it without ceremony.
export function phpSerialize(value: unknown): string {
  if (value === null) return "N;";
  if (typeof value === "boolean") return `b:${value ? 1 : 0};`;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return `i:${value};`;
    return `d:${value};`;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    return `s:${bytes}:"${value}";`;
  }
  if (Array.isArray(value)) {
    let body = "";
    for (let i = 0; i < value.length; i++) {
      body += `i:${i};` + phpSerialize(value[i]);
    }
    return `a:${value.length}:{${body}}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    let body = "";
    for (const [k, v] of entries) {
      body += phpSerialize(k) + phpSerialize(v);
    }
    return `a:${entries.length}:{${body}}`;
  }
  return "N;";
}

function slugifyForCf7(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

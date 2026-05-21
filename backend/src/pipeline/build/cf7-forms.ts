import type { FormField, FormVariant } from "../parse";

// Output of buildCf7Forms — one entry per FormVariant. The WXR builder
// emits a wpcf7_contact_form post per entry; templates.ts swaps each
// Scorpion contact form with [contact-form-7 id="<postId>" …] by looking
// the variant fingerprint up in formIdToCf7Lookup.
export interface Cf7Form {
  postId: number;
  slug: string;
  title: string;
  fingerprint: string;
  formTagMarkup: string;
  mailSerialized: string;
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
    const mailSerialized = buildMailSerialized({
      recipient,
      sender: fromSender,
      subject: `${args.siteTitle ?? "Site"} form submission`,
      fields: named,
    });

    return {
      postId,
      slug,
      title,
      fingerprint: variant.fingerprint,
      formTagMarkup,
      mailSerialized,
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

function normalizeAccept(accept: string): string {
  // CF7 wants pipe-separated extensions without dots: "jpg|png|gif"
  return accept
    .split(",")
    .map((s) => s.trim().replace(/^\./, "").replace(/^.+\//, ""))
    .filter((s) => s.length > 0)
    .join("|");
}

// CF7 stores _mail as a PHP-serialized associative array. We emit a
// sensible default; admins customise per-form in wp-admin → Contact.
function buildMailSerialized(args: {
  recipient: string;
  sender: string;
  subject: string;
  fields: NamedField[];
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

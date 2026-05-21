import * as cheerio from "cheerio";
import type { CrawlResult } from "../crawl";

export type FormFieldTag = "input" | "select" | "textarea";

export interface SelectOption {
  value: string;
  label: string;
}

export interface FormField {
  tag: FormFieldTag;
  inputType?: string;
  name?: string;
  placeholder?: string;
  required: boolean;
  label?: string;
  options?: SelectOption[];
  multiple?: boolean;
  maxlength?: number;
  minlength?: number;
  pattern?: string;
  accept?: string;
  min?: string;
  max?: string;
  step?: string;
}

export interface ExtractedForm {
  id?: string;
  action?: string;
  method?: string;
  fields: FormField[];
  submitText?: string;
}

export interface PageForms {
  pageUrl: string;
  path: string;
  forms: ExtractedForm[];
}

export interface FormOccurrence {
  pageUrl: string;
  path: string;
  formIndex: number;
  formId?: string;
}

export interface FormVariant {
  fingerprint: string;
  fields: FormField[];
  method?: string;
  submitText?: string;
  formIds: string[];
  occurrences: FormOccurrence[];
}

export interface FormAnalysis {
  variants: FormVariant[];
  pagesWithoutForms: { pageUrl: string; path: string }[];
}

export function extractFormsFromPage(
  html: string,
  pageUrl: string,
  path: string,
): PageForms {
  const $ = cheerio.load(html);
  const forms: ExtractedForm[] = [];

  $("form").each((_, formEl) => {
    const $form = $(formEl);
    // Scorpion marks AJAX search/filter forms with data-search="1".
    // These submit to JS handlers, not server endpoints, and are not
    // user-fillable "true" forms we want to migrate.
    if ($form.attr("data-search") === "1") return;

    const fields: FormField[] = [];
    const groupByName = new Map<string, number>();
    let submitText: string | undefined;

    $form
      .find("input, select, textarea, button")
      .each((_, fieldEl) => {
        const $field = $(fieldEl);
        const tagName = ($field.prop("tagName") ?? "")
          .toString()
          .toLowerCase();

        if (tagName === "button") {
          const btnType = $field.attr("type");
          if (!btnType || btnType === "submit") {
            const text = cleanLabel($field.text());
            if (text) submitText = text;
          }
          return;
        }

        if (tagName === "input") {
          const inputType = ($field.attr("type") ?? "text").toLowerCase();

          // Hidden + Scorpion control fields don't migrate to CF7.
          if (inputType === "hidden") return;

          if (inputType === "submit" || inputType === "button") {
            const text = $field.attr("value");
            if (text) submitText = text;
            return;
          }

          if (inputType === "radio" || inputType === "checkbox") {
            const name = $field.attr("name");
            const option: SelectOption = {
              value: $field.attr("value") ?? "",
              label: findLabelFor($form, $field) ?? "",
            };
            const required = $field.attr("required") !== undefined;

            if (name && groupByName.has(name)) {
              const idx = groupByName.get(name)!;
              const existing = fields[idx];
              existing.options = existing.options ?? [];
              existing.options.push(option);
              if (required) existing.required = true;
              return;
            }

            const field: FormField = {
              tag: "input",
              inputType,
              name,
              required,
              options: [option],
            };
            fields.push(field);
            if (name) groupByName.set(name, fields.length - 1);
            return;
          }

          // Single input field — text, email, tel, number, date, file, etc.
          const field: FormField = {
            tag: "input",
            inputType,
            name: $field.attr("name"),
            placeholder: $field.attr("placeholder"),
            required: $field.attr("required") !== undefined,
            label: findLabelFor($form, $field),
          };
          assignStringAttr(field, "pattern", $field.attr("pattern"));
          assignStringAttr(field, "accept", $field.attr("accept"));
          assignStringAttr(field, "min", $field.attr("min"));
          assignStringAttr(field, "max", $field.attr("max"));
          assignStringAttr(field, "step", $field.attr("step"));
          assignNumberAttr(field, "maxlength", $field.attr("maxlength"));
          assignNumberAttr(field, "minlength", $field.attr("minlength"));
          fields.push(field);
          return;
        }

        if (tagName === "select") {
          const options: SelectOption[] = [];
          $field.find("option").each((_, opt) => {
            const $opt = $(opt);
            const label = $opt.text().trim();
            if (!label) return;
            const value = $opt.attr("value") ?? label;
            options.push({ value, label });
          });
          const field: FormField = {
            tag: "select",
            name: $field.attr("name"),
            required: $field.attr("required") !== undefined,
            label: findLabelFor($form, $field),
            options,
            multiple: $field.attr("multiple") !== undefined,
          };
          fields.push(field);
          return;
        }

        if (tagName === "textarea") {
          const field: FormField = {
            tag: "textarea",
            name: $field.attr("name"),
            placeholder: $field.attr("placeholder"),
            required: $field.attr("required") !== undefined,
            label: findLabelFor($form, $field),
          };
          assignNumberAttr(field, "maxlength", $field.attr("maxlength"));
          assignNumberAttr(field, "minlength", $field.attr("minlength"));
          fields.push(field);
        }
      });

    forms.push({
      id: $form.attr("id"),
      action: $form.attr("action"),
      method: $form.attr("method"),
      fields,
      submitText,
    });
  });

  return { pageUrl, path, forms };
}

export function extractAllForms(crawl: CrawlResult): PageForms[] {
  const out: PageForms[] = [];
  for (const page of crawl.pages) {
    if (page.status !== "ok" || !page.fullHtml) continue;
    out.push(extractFormsFromPage(page.fullHtml, page.pageUrl, page.path));
  }
  return out;
}

export function analyzeForms(crawl: CrawlResult): FormAnalysis {
  const pageForms = extractAllForms(crawl);
  const byFingerprint = new Map<string, FormVariant>();
  const pagesWithoutForms: { pageUrl: string; path: string }[] = [];

  for (const page of pageForms) {
    if (page.forms.length === 0) {
      pagesWithoutForms.push({ pageUrl: page.pageUrl, path: page.path });
      continue;
    }
    page.forms.forEach((form, idx) => {
      const fingerprint = fingerprintForm(form);
      let variant = byFingerprint.get(fingerprint);
      if (!variant) {
        variant = {
          fingerprint,
          fields: form.fields,
          method: form.method,
          submitText: form.submitText,
          formIds: [],
          occurrences: [],
        };
        byFingerprint.set(fingerprint, variant);
      }
      if (form.id && !variant.formIds.includes(form.id)) {
        variant.formIds.push(form.id);
      }
      variant.occurrences.push({
        pageUrl: page.pageUrl,
        path: page.path,
        formIndex: idx,
        formId: form.id,
      });
    });
  }

  const variants = [...byFingerprint.values()].sort(
    (a, b) => b.occurrences.length - a.occurrences.length,
  );
  return { variants, pagesWithoutForms };
}

// Structural fingerprint. Deliberately excludes form id, action, and
// field name — Scorpion auto-generates positional identifiers like
// Form_ContactS2 vs Form_ContactS21 and field names like
// ContactS2Form$ITM0$FirstName that differ only by the form's index.
// Excluding them collapses what is operationally the same form template
// onto a single variant while the occurrences list keeps the per-page
// assignment.
function fingerprintForm(form: ExtractedForm): string {
  const fields = form.fields.map((f) => ({
    tag: f.tag,
    inputType: f.inputType,
    placeholder: f.placeholder,
    required: f.required,
    label: f.label,
    options: f.options,
    multiple: f.multiple,
    maxlength: f.maxlength,
    minlength: f.minlength,
    pattern: f.pattern,
    accept: f.accept,
    min: f.min,
    max: f.max,
    step: f.step,
  }));
  return JSON.stringify({ method: form.method, fields });
}

function findLabelFor(
  $form: cheerio.Cheerio<any>,
  $field: cheerio.Cheerio<any>,
): string | undefined {
  const id = $field.attr("id");
  if (id) {
    const $byFor = $form.find(`label[for="${cssEscape(id)}"]`).first();
    if ($byFor.length > 0) return cleanLabel($byFor.text());
  }
  const $wrap = $field.parents("label").first();
  if ($wrap.length > 0) return cleanLabel($wrap.text());
  return undefined;
}

function cleanLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

function assignStringAttr(
  field: FormField,
  key: "pattern" | "accept" | "min" | "max" | "step",
  value: string | undefined,
): void {
  if (value !== undefined && value !== "") field[key] = value;
}

function assignNumberAttr(
  field: FormField,
  key: "maxlength" | "minlength",
  value: string | undefined,
): void {
  if (value === undefined) return;
  const n = Number.parseInt(value, 10);
  if (Number.isFinite(n) && n > 0) field[key] = n;
}

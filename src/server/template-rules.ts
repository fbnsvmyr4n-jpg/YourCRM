/**
 * Message templates without a database: which merge fields exist, filling
 * them in for a person, and what an SMS will cost in segments.
 *
 * Shared by Settings, which checks a template as it is written, and the
 * composer, which fills one in for the person being written to.
 */

export const TEMPLATE_CHANNELS = ["email", "whatsapp", "sms"] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

export const CHANNEL_LABEL: Record<TemplateChannel, string> = { email: "Email", whatsapp: "WhatsApp", sms: "SMS" };

/** Every field a template may use, with what it becomes. The order is how Settings offers them. */
export const MERGE_FIELDS = {
  first_name: "Their first name",
  full_name: "Their full name",
  company: "Their company",
  my_name: "Your name",
  business_name: "Your business name",
} as const;
export type MergeField = keyof typeof MERGE_FIELDS;

export const MAX_TEMPLATE_NAME = 60;
export const MAX_TEMPLATE_SUBJECT = 200;
export const MAX_TEMPLATE_BODY = 5000;

export type MessageTemplate = {
  id: string;
  name: string;
  channel: TemplateChannel;
  subject: string;
  body: string;
  createdBy: string | null;
  updatedAt: string;
};

/** `{{ first_name }}`, spaces allowed inside the braces, case-insensitive. */
const FIELD = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export const isMergeField = (name: string): name is MergeField => Object.hasOwn(MERGE_FIELDS, name);

/** The field names a text uses, in order of first appearance, lower-cased. */
export function fieldsIn(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(FIELD)) {
    const name = m[1].toLowerCase();
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export type MergeValues = Partial<Record<MergeField, string | null | undefined>>;

/**
 * Fill a template in.
 *
 * A field with no value becomes nothing — never "{{company}}" in a client's
 * inbox — and is reported, so the person writing can see what to check before
 * sending. "Hi {{first_name}}," with no name reads "Hi ," and they are told.
 */
export function renderTemplate(text: string, values: MergeValues): { text: string; missing: MergeField[] } {
  const missing: MergeField[] = [];
  const out = text.replace(FIELD, (_whole, raw: string) => {
    const name = raw.toLowerCase();
    if (!isMergeField(name)) return "";
    const value = values[name]?.trim();
    if (!value) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return value;
  });
  return { text: out, missing };
}

/** The values for a person, from what the screen knows about them. */
export function valuesFor(person: { name?: string | null; company?: string | null }, me: { name?: string | null; business?: string | null }): MergeValues {
  const full = person.name?.trim() ?? "";
  return {
    first_name: full.split(/\s+/)[0] ?? "",
    full_name: full,
    company: person.company ?? "",
    my_name: me.name ?? "",
    business_name: me.business ?? "",
  };
}

export type TemplateInput = { name: string; channel: TemplateChannel; subject: string; body: string };

/** Check a template before it is stored. The error names the misspelt field. */
export function checkTemplate(raw: {
  name: unknown;
  channel: unknown;
  subject: unknown;
  body: unknown;
}): TemplateInput | { error: string } {
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (!name) return { error: "Give the template a name." };
  if (name.length > MAX_TEMPLATE_NAME) return { error: `Keep the name under ${MAX_TEMPLATE_NAME} characters.` };

  const channel = (TEMPLATE_CHANNELS as readonly unknown[]).includes(raw.channel) ? (raw.channel as TemplateChannel) : null;
  if (!channel) return { error: "Choose email, WhatsApp or SMS." };

  const subject = channel === "email" && typeof raw.subject === "string" ? raw.subject.replace(/\s+/g, " ").trim() : "";
  if (subject.length > MAX_TEMPLATE_SUBJECT) return { error: `Keep the subject under ${MAX_TEMPLATE_SUBJECT} characters.` };

  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!body) return { error: "Write the message." };
  if (body.length > MAX_TEMPLATE_BODY) return { error: `Keep the message under ${MAX_TEMPLATE_BODY} characters.` };

  const unknown = [...fieldsIn(subject), ...fieldsIn(body)].filter((f) => !isMergeField(f));
  if (unknown.length) {
    const list = [...new Set(unknown)].map((f) => `{{${f}}}`).join(", ");
    return { error: `${list} ${unknown.length === 1 ? "is not a field" : "are not fields"}. Use one of the fields listed under the message.` };
  }
  return { name, channel, subject, body };
}

/* The GSM 03.38 alphabet. Anything outside it — an emoji, "ş", a curly quote —
   switches the whole message to UCS-2 and cuts each segment to 70. */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "\f^{}\\[~]|€";

/**
 * How many SMS a text is billed as.
 *
 * One segment holds 160 GSM characters, or 153 each once the message is split;
 * with any character outside that alphabet it is 70, or 67 each. Extended
 * characters such as € and [ take two places.
 */
export function smsSegments(text: string): { segments: number; encoding: "GSM-7" | "UCS-2"; length: number } {
  let gsm = true;
  let units = 0;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXTENDED.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return { encoding: "GSM-7", length: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) };
  }
  const length = text.length; /* UTF-16 code units: an emoji is two */
  return { encoding: "UCS-2", length, segments: length <= 70 ? 1 : Math.ceil(length / 67) };
}

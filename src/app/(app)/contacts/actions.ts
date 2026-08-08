"use server";

import { revalidateApp } from "@/server/revalidate";
import { CONTACT_STATUSES, CONTACT_TYPES } from "@/data/contacts";
import {
  createContact,
  deleteContact,
  updateContact,
  type NewContact,
} from "@/server/contacts-repo";
import { email as validEmail, id as validId, multiline, pick, text } from "@/server/validate";

/** Returns null when the submission can't be trusted, so the caller rejects it. */
function parseContact(formData: FormData): NewContact | null {
  const firstName = text(formData.get("firstName"), 60);
  const lastName = text(formData.get("lastName"), 60);
  const email = validEmail(formData.get("email"));
  const type = pick(formData.get("type"), CONTACT_TYPES);
  const status = pick(formData.get("status"), CONTACT_STATUSES);

  // `type` decides whether someone is a client or a lead — it drives the
  // contacts donut on Reports and the client/lead counts on the dashboard.
  if ((!firstName && !lastName) || email === null || !type || !status) return null;

  return {
    firstName,
    lastName,
    email,
    phone: text(formData.get("phone"), 40),
    company: text(formData.get("company"), 80),
    companyInfo: multiline(formData.get("companyInfo"), 1000),
    type,
    status,
  };
}

export async function addContactAction(formData: FormData) {
  const input = parseContact(formData);
  if (!input) return;
  const created = await createContact(input);
  revalidateApp();
  return created.id;
}

export async function updateContactAction(id: string, formData: FormData) {
  const contactId = validId(id);
  const input = parseContact(formData);
  if (!contactId || !input) return;
  await updateContact(contactId, input);
  revalidateApp();
}

export async function deleteContactAction(id: string) {
  const contactId = validId(id);
  if (!contactId) return;
  await deleteContact(contactId);
  revalidateApp();
}

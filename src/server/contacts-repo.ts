import type { AvatarColor } from "@/components/ui/Avatar";
import { contacts as seed, type Contact } from "@/data/contacts";
import { mutateTable, readTable } from "./store";

const TABLE = "contacts";

const COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

export type NewContact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  companyInfo: string;
  type: Contact["type"];
  status: Contact["status"];
};

function initialsFor(first: string, last: string) {
  const a = first.trim()[0] ?? "";
  const b = last.trim()[0] ?? "";
  return (a + b || first.trim().slice(0, 2)).toUpperCase();
}

function slugId(first: string, last: string) {
  const base = `${first}-${last}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${base || "contact"}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function listContacts(): Promise<Contact[]> {
  return readTable<Contact>(TABLE, seed);
}

export async function getContact(id: string): Promise<Contact | undefined> {
  const rows = await listContacts();
  return rows.find((c) => c.id === id);
}

export async function createContact(input: NewContact): Promise<Contact> {
  let contact!: Contact;
  await mutateTable<Contact>(TABLE, seed, (rows) => {
    const first = input.firstName.trim();
    const last = input.lastName.trim();
    contact = {
      id: slugId(first, last),
      firstName: first,
      lastName: last,
      initials: initialsFor(first, last),
      color: COLORS[rows.length % COLORS.length],
      type: input.type,
      status: input.status,
      email: input.email.trim(),
      phone: input.phone.trim(),
      company: input.company.trim(),
      companyInfo: input.companyInfo.trim(),
      owner: "Lang Lee",
      info: input.companyInfo.trim() || input.company.trim() || `${input.type} contact`,
      activity: [
        {
          title: "Contact created",
          date: new Date().toLocaleString("en-US", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ],
    };
    return [contact, ...rows];
  });
  return contact;
}

export async function updateContact(
  id: string,
  patch: Partial<NewContact>
): Promise<Contact | undefined> {
  let updated: Contact | undefined;
  await mutateTable<Contact>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((c) => c.id === id);
    if (idx === -1) return rows;
    const current = rows[idx];
    const first = (patch.firstName ?? current.firstName).trim();
    const last = (patch.lastName ?? current.lastName).trim();
    updated = {
      ...current,
      ...patch,
      firstName: first,
      lastName: last,
      initials: initialsFor(first, last),
    };
    const next = [...rows];
    next[idx] = updated;
    return next;
  });
  return updated;
}

export async function deleteContact(id: string): Promise<void> {
  await mutateTable<Contact>(TABLE, seed, (rows) => rows.filter((c) => c.id !== id));
}

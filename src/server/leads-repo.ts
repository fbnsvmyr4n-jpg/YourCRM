import type { AvatarColor } from "@/components/ui/Avatar";
import { leadCards as seed, type LeadCard, type LeadSource } from "@/data/leads";
import { mutateTable, readTable } from "./store";

const TABLE = "leads";

const COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

export type NewLead = {
  name: string;
  email: string;
  phone: string;
  location: string;
  company: string;
  status: LeadCard["status"];
  source: LeadSource;
};

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b || name.trim().slice(0, 2)).toUpperCase();
}

function slugId(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${base || "lead"}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function listLeads(): Promise<LeadCard[]> {
  return readTable<LeadCard>(TABLE, seed);
}

export async function createLead(input: NewLead): Promise<LeadCard> {
  let lead!: LeadCard;
  await mutateTable<LeadCard>(TABLE, seed, (rows) => {
    const name = input.name.trim();
    lead = {
      id: slugId(name),
      initials: initialsFor(name),
      color: COLORS[rows.length % COLORS.length],
      name,
      email: input.email.trim(),
      phone: input.phone.trim(),
      location: input.location.trim() || "—",
      company: input.company.trim(),
      status: input.status,
      source: input.source,
      createdAt: new Date().toISOString(),
    };
    return [lead, ...rows];
  });
  return lead;
}

export async function updateLead(id: string, patch: NewLead): Promise<LeadCard | undefined> {
  let updated: LeadCard | undefined;
  await mutateTable<LeadCard>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((l) => l.id === id);
    if (idx === -1) return rows;
    const name = patch.name.trim();
    updated = { ...rows[idx], ...patch, name, initials: initialsFor(name) };
    const next = [...rows];
    next[idx] = updated;
    return next;
  });
  return updated;
}

export async function deleteLead(id: string): Promise<void> {
  await mutateTable<LeadCard>(TABLE, seed, (rows) => rows.filter((l) => l.id !== id));
}

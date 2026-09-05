/**
 * The company directory: everybody who works here, filed by department.
 *
 * Pure, and in its own module rather than inline in the page, because the
 * ordering IS the feature. A directory that lists people in the order their
 * accounts happened to be created is a list you have to read all of; one filed
 * by department is one you can scan to the right group and stop.
 */

export type DirectoryPerson = {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  jobTitle: string | null;
  phone: string | null;
  scope: string | null;
};

export type DirectoryGroup<T> = {
  /** Null is the group of people nobody has filed yet. */
  department: string | null;
  people: T[];
};

/**
 * Group by department, alphabetically, with the unfiled last.
 *
 * Unfiled goes last and is NOT hidden. On the day somebody joins they have no
 * department, and a directory that quietly omitted them would be wrong in the
 * one way a directory must never be wrong — the new person is exactly who
 * everybody is looking up.
 *
 * Departments are matched exactly, so "Sales" and "sales" are two groups. That
 * is deliberate rather than lazy: the alternative is deciding on the customer's
 * behalf that two spellings mean the same team, and the fix for a typo belongs
 * in the field, where somebody can see it, not in a normaliser that hides it.
 * They are SORTED case-insensitively so the two at least sit together.
 */
export function groupByDepartment<T extends { department: string | null; name: string }>(
  people: T[]
): DirectoryGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const person of people) {
    const key = person.department?.trim() ? person.department : null;
    const bucket = groups.get(key);
    if (bucket) bucket.push(person);
    else groups.set(key, [person]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    })
    .map(([department, members]) => ({
      department,
      people: [...members].sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

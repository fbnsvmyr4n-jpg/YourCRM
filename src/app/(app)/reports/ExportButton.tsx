"use client";

import { useState } from "react";
import { Check, Download } from "lucide-react";

/**
 * Downloads the figures on screen as a CSV.
 *
 * This control used to be decoration — a button labelled Export that did
 * nothing when pressed. It now writes the same rows the page renders, built on
 * the server from stored records, so the file and the screen cannot disagree.
 */
export function ExportButton({ rows, filename }: { rows: string[][]; filename: string }) {
  const [done, setDone] = useState(false);

  function download() {
    // Quote every field and double any inner quotes — company names contain
    // commas, and a deal title could contain either.
    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    setDone(true);
    setTimeout(() => setDone(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium"
    >
      {done ? (
        <>
          <Check className="h-4 w-4 text-green" /> Downloaded
        </>
      ) : (
        <>
          <Download className="h-4 w-4 text-accent" /> Export CSV
        </>
      )}
    </button>
  );
}

import { Card } from "./Card";
import { Sparkles } from "lucide-react";

export function ComingSoon({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      <Card className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <span
          className="grid h-16 w-16 place-items-center rounded-2xl"
          style={{ background: "var(--accent-soft)" }}
        >
          <Sparkles className="h-8 w-8 text-accent" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 max-w-md text-sm text-muted">
            {note ?? "This screen is on the roadmap and will be built next, matching your reference designs."}
          </p>
        </div>
      </Card>
    </div>
  );
}

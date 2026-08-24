"use client";

import { useEffect, useState } from "react";
import { useEnvironmentClock } from "./EnvironmentProvider";
import { ENV_PROPERTIES } from "@/lib/environment/publish";
import { PHASE_LABELS, PHASE_SEQUENCE } from "@/lib/environment/phases";
import type { SolarPhase } from "@/lib/solar/types";

/**
 * The simulator. Mandatory, per §19 — and moved early, before anything is drawn.
 *
 * The specification puts this at step 16 of 20. It belongs here instead,
 * because every stage after it is verified *through* it: without a scrubber,
 * checking that sunset works means waiting for one, and checking the polar
 * night means waiting until December and moving to Norway.
 *
 * **This file must never reach a browser that is not ours.** It can override
 * location and time, and it is excluded from production builds by the bundler
 * rather than by a runtime flag — a flag is a variable somebody can set, and
 * `tests/dev-panel-excluded.test.ts` fails the build if this ever ships. The
 * guard is the same shape as the server/client boundary test, which exists
 * because `tsc` and `next build` both missed a defect once already.
 */

const PLACES: { name: string; latitude: number; longitude: number }[] = [
  { name: "Cape Town", latitude: -33.9, longitude: 18.4 },
  { name: "London", latitude: 51.5, longitude: -0.1 },
  { name: "Equator", latitude: 0, longitude: 0 },
  { name: "Tromsø (Arctic)", latitude: 69.7, longitude: 19 },
  { name: "Ushuaia", latitude: -54.8, longitude: -68.3 },
  { name: "Svalbard", latitude: 78.2, longitude: 15.6 },
];

const SPEEDS = [1, 10, 60, 600, 3600];

export function DevEnvironmentPanel() {
  const clock = useEnvironmentClock();
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  const [simulating, setSimulating] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [date, setDate] = useState("2026-03-20");
  const [place, setPlace] = useState(PLACES[0]);
  const [minute, setMinute] = useState(12 * 60);
  const [reduced, setReduced] = useState(false);
  const [lowPower, setLowPower] = useState(false);

  /**
   * The panel is the one thing that legitimately re-renders continuously — it
   * is a readout, and a readout that does not move is not one. Four times a
   * second while open, not sixty: fast enough to look live, slow enough to stay
   * off the profile of the thing being measured.
   *
   * It keeps ticking when COLLAPSED too, which the first version did not. That
   * version gated the interval on `open`, so the chip froze at whatever it
   * showed on mount — and it sat there reading "Blue hour · −8.3°" while the
   * scene behind it had already resolved to sunset at −3.6°. A readout that
   * stops reading is worse than no readout: it is a confident wrong answer,
   * which is exactly what you consult it to rule out.
   */
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), open ? 250 : 2000);
    return () => clearInterval(id);
  }, [open]);

  if (!clock) return null;

  const solar = clock.solar();
  const state = clock.read();

  const applyTime = (nextMinute: number, nextDate = date, nextPlace = place) => {
    const [y, m, d] = nextDate.split("-").map(Number);
    const at = Date.UTC(y, m - 1, d, 0, nextMinute);
    clock.override({
      at,
      speed,
      location: { latitude: nextPlace.latitude, longitude: nextPlace.longitude, source: "gps" },
    });
  };

  /**
   * Jump to the first minute of a phase.
   *
   * Searched rather than tabulated, because the altitude a phase begins at
   * happens at a different clock time every day and at every latitude — there
   * is no "sunset o'clock" to hard-code. Scanning the day for the first minute
   * that classifies as the wanted phase is both correct everywhere and honest
   * about the fact that some phases genuinely do not occur: inside the Arctic
   * Circle in June there is no night to jump to, and the button says so rather
   * than silently landing somewhere near it.
   */
  const jumpTo = (phase: SolarPhase) => {
    const [y, m, d] = date.split("-").map(Number);
    const where = { latitude: place.latitude, longitude: place.longitude, source: "gps" as const };

    // Collect every minute in the phase, then land in the MIDDLE of it.
    //
    // Jumping to the first matching minute — which is what this did at first —
    // always arrives at the phase's dimmest edge, because that is where it
    // begins. "Dawn" landed one minute after night and looked exactly like
    // night, which is correct and completely useless for looking at anything.
    // The middle is where a phase actually looks like itself.
    const minutes: number[] = [];
    for (let candidate = 0; candidate < 1440; candidate += 2) {
      clock.override({ at: Date.UTC(y, m - 1, d, 0, candidate), location: where });
      if (clock.target().phase === phase) minutes.push(candidate);
    }

    if (minutes.length === 0) {
      applyTime(minute);
      // Said plainly rather than landing somewhere near it. Inside the Arctic
      // Circle in June there is genuinely no night, and a button that silently
      // did nothing would read as broken rather than as informative.
      window.alert(`No ${PHASE_LABELS[phase].toLowerCase()} at ${place.name} on ${date}.`);
      return;
    }

    /**
     * The middle of the CONTIGUOUS run, not of the whole list.
     *
     * Several phases occur twice a day — night wraps around midnight, so its
     * minutes are two clusters at either end of the list and their average is
     * midday. Averaging the list would jump to full sun and label it night.
     */
    let bestStart = 0;
    let bestLength = 0;
    let runStart = 0;
    for (let i = 1; i <= minutes.length; i++) {
      const broken = i === minutes.length || minutes[i] !== minutes[i - 1] + 2;
      if (broken) {
        const length = i - runStart;
        if (length > bestLength) {
          bestLength = length;
          bestStart = runStart;
        }
        runStart = i;
      }
    }

    const target = minutes[bestStart + Math.floor(bestLength / 2)];
    setMinute(target);
    setSimulating(true);
    applyTime(target, date, place);
  };

  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 90,
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: 11,
        color: "#dbe7f5",
      }}
    >
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ ...chip, cursor: "pointer" }}
          aria-label="Open the environment simulator"
        >
          ☀ {PHASE_LABELS[state.phase]} · {solar.altitudeDeg.toFixed(1)}°
        </button>
      ) : (
        <div
          style={{
            width: 300,
            padding: 14,
            borderRadius: 14,
            background: "rgba(8,12,20,0.94)",
            border: "1px solid rgba(120,160,200,0.28)",
            backdropFilter: "blur(12px)",
            boxShadow: "0 20px 60px -20px rgba(0,0,0,0.9)",
            maxHeight: "80vh",
            overflowY: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <strong style={{ letterSpacing: ".08em" }}>ENVIRONMENT</strong>
            <button type="button" onClick={() => setOpen(false)} style={close} aria-label="Close">
              ✕
            </button>
          </div>

          <Row label="Phase" value={PHASE_LABELS[state.phase]} />
          <Row label="Altitude" value={`${solar.altitudeDeg.toFixed(2)}°`} />
          <Row label="Azimuth" value={`${solar.azimuthDeg.toFixed(1)}°`} />
          <Row label="Rising" value={solar.rising ? "yes" : "no"} />
          <Row label="Polar day" value={solar.polar ? "YES — no sunrise/sunset" : "no"} />
          <Row
            label="Sunrise"
            value={solar.sunrise ? new Date(solar.sunrise).toISOString().slice(11, 16) : "—"}
          />
          <Row
            label="Sunset"
            value={solar.sunset ? new Date(solar.sunset).toISOString().slice(11, 16) : "—"}
          />

          <hr style={rule} />

          <label style={line}>
            <input
              type="checkbox"
              checked={simulating}
              onChange={(e) => {
                setSimulating(e.target.checked);
                if (e.target.checked) applyTime(minute);
                else clock.override({ at: null, speed: 1 });
              }}
            />
            Simulated time
          </label>

          <label style={line}>
            <input
              type="checkbox"
              checked={reduced}
              onChange={(e) => {
                setReduced(e.target.checked);
                clock.setReducedMotion(e.target.checked);
              }}
            />
            Reduced motion
          </label>

          <label style={line}>
            <input
              type="checkbox"
              checked={lowPower || clock.isLowPower()}
              onChange={(e) => {
                setLowPower(e.target.checked);
                clock.setLowPower(e.target.checked);
              }}
            />
            Low power {clock.isLowPower() && !lowPower ? "(measured)" : ""}
          </label>

          <div style={{ opacity: simulating ? 1 : 0.4, pointerEvents: simulating ? "auto" : "none" }}>
            <div style={{ margin: "10px 0 4px" }}>
              Time · <strong>{hh}:{mm} UTC</strong>
            </div>
            <input
              type="range"
              min={0}
              max={1439}
              value={minute}
              onChange={(e) => {
                const next = Number(e.target.value);
                setMinute(next);
                applyTime(next);
              }}
              style={{ width: "100%" }}
              aria-label="Time of day"
            />

            <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  applyTime(minute, e.target.value);
                }}
                style={{ ...field, flex: 1 }}
              />
              <select
                value={speed}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setSpeed(next);
                  clock.override({ speed: next });
                }}
                style={field}
                aria-label="Playback speed"
              >
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </div>

            <select
              value={place.name}
              onChange={(e) => {
                const next = PLACES.find((p) => p.name === e.target.value)!;
                setPlace(next);
                applyTime(minute, date, next);
              }}
              style={{ ...field, width: "100%", marginBottom: 8 }}
              aria-label="Location"
            >
              {PLACES.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {PHASE_SEQUENCE.map((phase) => (
                <button
                  key={phase}
                  type="button"
                  onClick={() => jumpTo(phase)}
                  style={{
                    ...chip,
                    padding: "3px 7px",
                    cursor: "pointer",
                    borderColor:
                      state.phase === phase ? "rgba(150,200,255,0.7)" : "rgba(120,160,200,0.25)",
                  }}
                >
                  {PHASE_LABELS[phase]}
                </button>
              ))}
            </div>
          </div>

          <hr style={rule} />
          {ENV_PROPERTIES.map((key) => (
            <Bar key={key} label={key} value={state[key]} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
      <span style={{ opacity: 0.6, width: 108, fontSize: 10 }}>{label}</span>
      <span style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 9 }}>
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${Math.round(value * 100)}%`,
            background: "linear-gradient(90deg,#4f9dff,#2ad0e0)",
            borderRadius: 9,
          }}
        />
      </span>
      <span style={{ width: 34, textAlign: "right", fontSize: 10 }}>{value.toFixed(2)}</span>
    </div>
  );
}

const chip: React.CSSProperties = {
  padding: "5px 10px",
  borderRadius: 9,
  background: "rgba(8,12,20,0.9)",
  border: "1px solid rgba(120,160,200,0.28)",
  color: "#dbe7f5",
  font: "inherit",
};

const close: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#8fa4bd",
  cursor: "pointer",
  font: "inherit",
};

const rule: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid rgba(120,160,200,0.2)",
  margin: "10px 0",
};

const field: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(120,160,200,0.25)",
  borderRadius: 7,
  color: "#dbe7f5",
  font: "inherit",
  padding: "3px 6px",
};

const line: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  padding: "2px 0",
};

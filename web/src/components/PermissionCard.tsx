import { useState } from "react";
import type { PermissionRequest } from "../api";
import { Markdown } from "./Markdown";
import { toolSummary } from "./transcript";

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  always?: boolean;
  updatedInput?: Record<string, unknown>;
}

type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };

function AskUserQuestion({ req, onRespond }: { req: PermissionRequest; onRespond: (d: PermissionDecision) => void }) {
  const questions = (req.input.questions as Question[] | undefined) ?? [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: Question, label: string) =>
    setAnswers((a) => {
      const cur = a[q.question] ?? [];
      if (!q.multiSelect) return { ...a, [q.question]: [label] };
      return { ...a, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });

  const submit = () => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const picked = [...(answers[q.question] ?? [])];
      if (other[q.question]?.trim()) picked.push(other[q.question].trim());
      out[q.question] = picked.join(", ");
    }
    onRespond({ behavior: "allow", updatedInput: { ...req.input, answers: out } });
  };

  return (
    <div className="perm card">
      <div className="perm-title">Claude has a question</div>
      {questions.map((q) => (
        <div key={q.question} className="question">
          <div className="q-text">{q.question}</div>
          <div className="options">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className={`option ${(answers[q.question] ?? []).includes(o.label) ? "on" : ""}`}
                onClick={() => toggle(q, o.label)}
              >
                <strong>{o.label}</strong>
                {o.description && <span>{o.description}</span>}
              </button>
            ))}
          </div>
          <input placeholder="Other…" value={other[q.question] ?? ""} onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))} />
        </div>
      ))}
      <div className="perm-actions">
        <button className="btn primary" onClick={submit}>
          Answer
        </button>
        <button className="btn ghost" onClick={() => onRespond({ behavior: "deny", message: "The user declined to answer." })}>
          Skip
        </button>
      </div>
    </div>
  );
}

export function PermissionCard({ req, onRespond }: { req: PermissionRequest; onRespond: (d: PermissionDecision) => void }) {
  const [feedback, setFeedback] = useState("");
  if (req.toolName === "AskUserQuestion") return <AskUserQuestion req={req} onRespond={onRespond} />;

  const isPlan = req.toolName === "ExitPlanMode";
  return (
    <div className="perm card">
      <div className="perm-title">{isPlan ? "Ready to leave plan mode?" : req.title || `Allow ${req.displayName || req.toolName}?`}</div>
      {req.description && <div className="muted small">{req.description}</div>}
      {isPlan && typeof req.input.plan === "string" ? (
        <div className="plan">
          <Markdown text={req.input.plan} />
        </div>
      ) : (
        <>
          <code className="perm-summary">
            {req.toolName}: {toolSummary(req.toolName, req.input)}
          </code>
          <details>
            <summary className="muted small">Full input</summary>
            <pre>{JSON.stringify(req.input, null, 2)}</pre>
          </details>
        </>
      )}
      {req.decisionReason && <div className="muted small">Reason: {req.decisionReason}</div>}
      <input placeholder={isPlan ? "Feedback to keep planning (optional)" : "Reason if denying (optional)"} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="perm-actions">
        <button className="btn primary" onClick={() => onRespond({ behavior: "allow" })}>
          {isPlan ? "Approve plan" : "Allow"}
        </button>
        {req.canAlwaysAllow && !isPlan && (
          <button className="btn" onClick={() => onRespond({ behavior: "allow", always: true })}>
            Always allow
          </button>
        )}
        <button className="btn danger" onClick={() => onRespond({ behavior: "deny", message: feedback || undefined })}>
          {isPlan ? "Keep planning" : "Deny"}
        </button>
      </div>
    </div>
  );
}

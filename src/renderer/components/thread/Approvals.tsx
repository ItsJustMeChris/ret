import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FilePen, Globe, KeyRound, MessageCircleQuestion, ShieldAlert, SquareTerminal } from "lucide-react";
import { useThreads, type PendingRequest } from "../../state/threads";
import { respondToRequest } from "../../state/actions";
import { bridge } from "../../bridge";
import { Select } from "../ui/Select";
import { Checkbox } from "../ui/Toggle";
import { unwrapCommand } from "../../lib/format";

export function Approvals({ threadId }: { threadId: string }) {
  const reqs = useThreads(useShallow((s) => Object.values(s.requests).filter((r) => r.threadId === threadId)));
  if (!reqs.length) return null;
  return (
    <div className="approvals">
      {[...reqs]
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .map((r) => (
          <RequestCard key={r.key} req={r} />
        ))}
    </div>
  );
}

function Buttons({ choices }: { choices: { label: string; onClick: () => void; kind?: "primary" | "danger" | "ghost"; hint?: string }[] }) {
  return (
    <div className="approval-actions">
      {choices.map((c) => (
        <button key={c.label} className={`btn ${c.kind ?? ""}`} onClick={c.onClick} title={c.hint}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function RequestCard({ req, compact }: { req: PendingRequest; compact?: boolean }) {
  const p = req.params;
  const send = (result: unknown) => respondToRequest(req.key, result);

  switch (req.method) {
    case "item/commandExecution/requestApproval": {
      const amend = p.proposedExecpolicyAmendment as string[] | null | undefined;
      const net = p.networkApprovalContext as { host: string; protocol: string } | null | undefined;
      return (
        <div className="approval">
          <div className="approval-title">
            {net ? <Globe size={14} /> : <SquareTerminal size={14} />}
            {net ? `Allow network access to ${net.host}?` : "Run this command?"}
          </div>
          {p.command && <pre className="approval-cmd">{unwrapCommand(p.command)}</pre>}
          {p.reason && !compact && <div className="approval-reason">{p.reason}</div>}
          <Buttons
            choices={[
              { label: "Run", kind: "primary", onClick: () => send({ decision: "accept" }) },
              { label: "Always this session", onClick: () => send({ decision: "acceptForSession" }) },
              ...(amend?.length
                ? [
                    {
                      label: `Always allow “${amend.join(" ")}”`,
                      onClick: () => send({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amend } } }),
                    },
                  ]
                : []),
              { label: "Decline", kind: "ghost" as const, onClick: () => send({ decision: "decline" }) },
              { label: "Stop turn", kind: "danger" as const, onClick: () => send({ decision: "cancel" }) },
            ]}
          />
        </div>
      );
    }
    case "item/fileChange/requestApproval":
      return (
        <div className="approval">
          <div className="approval-title">
            <FilePen size={14} /> Apply these edits?
          </div>
          {p.reason && <div className="approval-reason">{p.reason}</div>}
          {p.grantRoot && <div className="approval-reason">Grants write access to <code>{p.grantRoot}</code></div>}
          <Buttons
            choices={[
              { label: "Apply", kind: "primary", onClick: () => send({ decision: "accept" }) },
              { label: "Always this session", onClick: () => send({ decision: "acceptForSession" }) },
              { label: "Decline", kind: "ghost", onClick: () => send({ decision: "decline" }) },
              { label: "Stop turn", kind: "danger", onClick: () => send({ decision: "cancel" }) },
            ]}
          />
        </div>
      );
    case "item/permissions/requestApproval": {
      const perms = p.permissions ?? {};
      const granted: Record<string, unknown> = {};
      if (perms.network) granted.network = perms.network;
      if (perms.fileSystem) granted.fileSystem = perms.fileSystem;
      return (
        <div className="approval">
          <div className="approval-title">
            <ShieldAlert size={14} /> Grant extra permissions?
          </div>
          {p.reason && <div className="approval-reason">{p.reason}</div>}
          <ul className="perm-list">
            {perms.network?.enabled && <li>Network access</li>}
            {perms.fileSystem?.write?.map((w: string) => <li key={"w" + w}>Write: <code>{w}</code></li>)}
            {perms.fileSystem?.read?.map((r: string) => <li key={"r" + r}>Read: <code>{r}</code></li>)}
          </ul>
          <Buttons
            choices={[
              { label: "Allow for turn", kind: "primary", onClick: () => send({ permissions: granted, scope: "turn" }) },
              { label: "Allow for session", onClick: () => send({ permissions: granted, scope: "session" }) },
              { label: "Deny", kind: "ghost", onClick: () => send({ permissions: {}, scope: "turn" }) },
            ]}
          />
        </div>
      );
    }
    case "item/tool/requestUserInput":
      return <UserInputCard req={req} />;
    case "mcpServer/elicitation/request":
      return <ElicitationCard req={req} />;
    case "execCommandApproval":
    case "applyPatchApproval":
      return (
        <div className="approval">
          <div className="approval-title">
            {req.method === "execCommandApproval" ? <SquareTerminal size={14} /> : <FilePen size={14} />}
            {req.method === "execCommandApproval" ? "Run this command?" : "Apply these edits?"}
          </div>
          {p.command && <pre className="approval-cmd">{(p.command as string[]).join(" ")}</pre>}
          {p.reason && <div className="approval-reason">{p.reason}</div>}
          <Buttons
            choices={[
              { label: "Approve", kind: "primary", onClick: () => send({ decision: "approved" }) },
              { label: "Always this session", onClick: () => send({ decision: "approved_for_session" }) },
              { label: "Deny", kind: "ghost", onClick: () => send({ decision: { denied: { rejection: "Declined by user" } } }) },
              { label: "Stop turn", kind: "danger", onClick: () => send({ decision: "abort" }) },
            ]}
          />
        </div>
      );
    default:
      return (
        <div className="approval">
          <div className="approval-title">Unsupported request: {req.method}</div>
          <Buttons choices={[{ label: "Dismiss", onClick: () => send({}) }]} />
        </div>
      );
  }
}

function UserInputCard({ req }: { req: PendingRequest }) {
  const questions: { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] | null }[] =
    req.params.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const submit = () =>
    respondToRequest(req.key, {
      answers: Object.fromEntries(questions.map((q) => [q.id, { answers: answers[q.id] ? [answers[q.id]] : [] }])),
    });
  return (
    <div className="approval">
      <div className="approval-title">
        <MessageCircleQuestion size={14} /> Codex has a question
      </div>
      {questions.map((q) => (
        <div key={q.id} className="question">
          {q.header && <div className="q-header">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          {q.options?.length ? (
            <div className="q-options">
              {q.options.map((o) => (
                <button
                  key={o.label}
                  className={`q-option ${answers[q.id] === o.label ? "selected" : ""}`}
                  onClick={() => setAnswers({ ...answers, [q.id]: o.label })}
                  title={o.description}
                >
                  <span>{o.label}</span>
                  {o.description && <small>{o.description}</small>}
                </button>
              ))}
            </div>
          ) : null}
          {(!q.options?.length || q.isOther) && (
            <input
              className="input"
              type={q.isSecret ? "password" : "text"}
              placeholder={q.options?.length ? "Other…" : "Your answer"}
              value={answers[q.id] && !q.options?.some((o) => o.label === answers[q.id]) ? answers[q.id] : ""}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          )}
        </div>
      ))}
      <Buttons choices={[{ label: "Submit", kind: "primary", onClick: submit }]} />
    </div>
  );
}

function ElicitationCard({ req }: { req: PendingRequest }) {
  const p = req.params;
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const send = (action: "accept" | "decline" | "cancel", content: unknown = null) =>
    respondToRequest(req.key, { action, content, _meta: null });
  const props: Record<string, any> = p.mode === "form" ? (p.requestedSchema?.properties ?? {}) : {};
  return (
    <div className="approval">
      <div className="approval-title">
        <KeyRound size={14} /> {p.serverName} needs input
      </div>
      <div className="approval-reason">{p.message}</div>
      {Object.entries(props).map(([key, schema]) => (
        <label key={key} className="field">
          <span>{schema.title ?? key}</span>
          {schema.type === "boolean" ? (
            <Checkbox checked={!!values[key]} onChange={(v) => setValues({ ...values, [key]: v })} label={schema.description} />
          ) : schema.enum ? (
            <Select
              variant="field"
              value={String(values[key] ?? "")}
              options={(schema.enum as string[]).map((v, i) => ({ value: v, label: schema.enumNames?.[i] ?? v }))}
              onChange={(v) => setValues({ ...values, [key]: v })}
              placeholder="Choose…"
            />
          ) : (
            <input className="input" value={String(values[key] ?? "")} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
          )}
        </label>
      ))}
      <Buttons
        choices={[
          p.mode === "url"
            ? {
                label: "Open link",
                kind: "primary",
                onClick: () => {
                  void bridge.shell.openExternal(p.url);
                  send("accept");
                },
              }
            : {
                label: "Submit",
                kind: "primary",
                onClick: () => {
                  const content: Record<string, unknown> = {};
                  for (const [k, schema] of Object.entries(props)) {
                    const v = values[k];
                    if (v === undefined || v === "") continue;
                    content[k] = schema.type === "number" || schema.type === "integer" ? Number(v) : v;
                  }
                  send("accept", content);
                },
              },
          { label: "Decline", kind: "ghost", onClick: () => send("decline") },
        ]}
      />
    </div>
  );
}

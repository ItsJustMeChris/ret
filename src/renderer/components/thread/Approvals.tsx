import { useState } from "react";
import { FilePen, Globe, KeyRound, MessageCircleQuestion, ShieldAlert, SquareTerminal, Wrench } from "lucide-react";
import { hostOf } from "@shared/bridge";
import { type PendingRequest } from "../../state/threads";
import { useThread } from "../../state/useThread";
import { shallowEqual } from "../../lib/shallow";
import { agentOf } from "../../agents";
import { respondToRequest } from "../../state/actions";
import { bridge } from "../../bridge";
import { Select } from "../ui/Select";
import { Checkbox } from "../ui/Toggle";
import { unwrapCommand } from "../../lib/format";
import { appAskedFor, appLabel, displayParams, isPermissionAsk, persistOffered } from "../../state/computerUse";
import { AppIcon, AppName } from "./ComputerUse";

export function Approvals({ threadId }: { threadId: string }) {
  // Questions (request_user_input) are answered in the dock on top of the composer instead.
  const reqs = useThread(
    threadId,
    (s) => Object.values(s.requests).filter((r) => r.threadId === threadId && r.method !== "item/tool/requestUserInput"),
    shallowEqual,
  );
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
    case "item/tool/requestApproval": {
      // A provider's own tool (fetching a page, an MCP tool…) that it asks before using.
      const args = p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : null;
      const shown = args ? Object.entries(args).filter(([, v]) => v != null && v !== "") : [];
      return (
        <div className="approval">
          <div className="approval-title">
            <Wrench size={14} /> {p.title ?? `Use ${p.server ? `${p.server} · ` : ""}${p.tool}?`}
          </div>
          {p.description && !compact && <div className="approval-reason">{p.description}</div>}
          {shown.length > 0 && !compact && (
            <pre className="approval-cmd">{shown.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n").slice(0, 2000)}</pre>
          )}
          {p.reason && !compact && <div className="approval-reason">{p.reason}</div>}
          <Buttons
            choices={[
              { label: "Allow", kind: "primary", onClick: () => send({ decision: "accept" }) },
              { label: "Always this session", onClick: () => send({ decision: "acceptForSession" }) },
              { label: "Decline", kind: "ghost", onClick: () => send({ decision: "decline" }) },
              { label: "Stop turn", kind: "danger", onClick: () => send({ decision: "cancel" }) },
            ]}
          />
        </div>
      );
    }
    case "item/tool/requestUserInput":
      return <UserInputCard req={req} />;
    case "mcpServer/elicitation/request":
      return isPermissionAsk(p) ? <PermissionAskCard req={req} compact={compact} /> : <ElicitationCard req={req} />;
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

/**
 * The agent stopped to ask (Codex's request_user_input, Claude Code's AskUserQuestion): one or more questions, each
 * with suggested answers and/or room to write your own. Skipping tells it you'd rather not say.
 * Shown where there's no composer (glance windows); thread panes answer in the QuestionDock.
 */
function UserInputCard({ req }: { req: PendingRequest }) {
  const questions: { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] | null }[] =
    req.params.questions ?? [];
  const blocking = req.params.isBlocking !== false;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const ready = questions.every((q) => answers[q.id]?.trim());
  const reply = (values: Record<string, string>) =>
    respondToRequest(req.key, {
      answers: Object.fromEntries(questions.map((q) => [q.id, { answers: values[q.id]?.trim() ? [values[q.id].trim()] : [] }])),
    });
  const single = questions.length === 1 && !!questions[0].options?.length && !questions[0].isOther;
  const name = agentOf(req.engine).name;
  return (
    <div className="approval asking">
      <div className="approval-title">
        <MessageCircleQuestion size={14} /> {questions.length > 1 ? `${name} has ${questions.length} questions` : `${name} has a question`}
      </div>
      {!blocking && <div className="approval-reason">{name} keeps working meanwhile; answer whenever you're ready.</div>}
      {questions.map((q, n) => (
        <div key={q.id} className="question">
          {q.header && <div className="q-header">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          {q.options?.length ? (
            <div className="q-options">
              {q.options.map((o) => (
                <button
                  key={o.label}
                  className={`q-option ${answers[q.id] === o.label ? "selected" : ""}`}
                  onClick={() => {
                    const next = { ...answers, [q.id]: o.label };
                    setAnswers(next);
                    if (single) reply(next); // one question with fixed choices: one click answers it
                  }}
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
              autoFocus={n === 0 && !q.options?.length}
              placeholder={q.options?.length ? "Or answer in your own words…" : "Your answer"}
              value={answers[q.id] && !q.options?.some((o) => o.label === answers[q.id]) ? answers[q.id] : ""}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && ready) reply(answers);
              }}
            />
          )}
        </div>
      ))}
      <div className="approval-actions">
        {!single && (
          <button className="btn primary" disabled={!ready} onClick={() => reply(answers)}>
            Answer
          </button>
        )}
        <button className="btn ghost" title={`Let ${name} carry on without an answer`} onClick={() => reply({})}>
          Skip
        </button>
      </div>
    </div>
  );
}

/**
 * A tool asking before it acts (Codex's computer use asking to use an app, an MCP tool asking to
 * run): allow it once or for this session, or always, which Codex remembers past this session, so
 * it takes a second click (and isn't offered in a glance); deny it; or stop the turn.
 */
function PermissionAskCard({ req, compact }: { req: PendingRequest; compact?: boolean }) {
  const p = req.params;
  const meta = p._meta ?? {};
  const persist = persistOffered(p);
  const app = appAskedFor(p);
  const callId = typeof meta.callId === "string" ? meta.callId : null;
  // The step waiting on this says what it's for ("Connect to Finder").
  const purpose = useThread(req.threadId ?? "", (s) => {
    const step = callId && req.threadId ? s.live[req.threadId]?.items[callId] : undefined;
    const title = step?.type === "mcpToolCall" ? (step.arguments as { title?: unknown } | null)?.title : null;
    return typeof title === "string" ? title : null;
  });
  const details = displayParams(meta.tool_params_display).filter((d) => !(app && d.name === "app"));
  const [sure, setSure] = useState(false);
  const host = hostOf(req.engine);
  const what = app ? appLabel(app, null, host) : "this tool";
  const send = (action: "accept" | "decline" | "cancel", remember?: "session" | "always") =>
    respondToRequest(req.key, { action, content: action === "accept" ? {} : null, _meta: remember ? { persist: remember } : null });
  return (
    <div className="approval">
      <div className="approval-title">
        {app ? (
          <>
            <AppIcon use={app} host={host} size={16} /> Let {agentOf(req.engine).name} use <AppName use={app} host={host} />?
          </>
        ) : (
          <>
            <KeyRound size={14} /> {typeof p.message === "string" ? p.message : "Allow this tool?"}
          </>
        )}
      </div>
      {!compact && (purpose || details.length > 0) && (
        <div className="approval-reason">
          {purpose}
          {details.map((d) => (
            <div key={d.name}>
              {d.label}: <code>{typeof d.value === "string" ? d.value : (JSON.stringify(d.value) ?? "")}</code>
            </div>
          ))}
        </div>
      )}
      <Buttons
        choices={[
          { label: "Allow", kind: "primary", onClick: () => send("accept") },
          ...(persist.session ? [{ label: "Always this session", onClick: () => send("accept", "session") }] : []),
          ...(persist.always && !compact
            ? [
                {
                  label: sure ? `Click again to always allow ${what}` : `Always allow ${what}…`,
                  hint: `${agentOf(req.engine).name} remembers this and won't ask again, in later sessions too`,
                  onClick: () => (sure ? send("accept", "always") : setSure(true)),
                },
              ]
            : []),
          { label: "Deny", kind: "ghost" as const, onClick: () => send("decline") },
          { label: "Stop turn", kind: "danger" as const, onClick: () => send("cancel") },
        ]}
      />
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

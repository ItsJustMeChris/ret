import * as Haptics from "expo-haptics";
import { FilePen, Globe, KeyRound, ShieldAlert, SquareTerminal, Wrench, type LucideIcon } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { hostOf } from "@shared/bridge";
import { unwrapCommand } from "@ret/lib/format";
import { shallowEqual } from "@ret/lib/shallow";
import { respondToRequest } from "@ret/state/actions";
import { appAskedFor, appLabel, displayParams, isPermissionAsk, persistOffered } from "@ret/state/computerUse";
import type { PendingRequest } from "@ret/state/threads";
import { useThread } from "@ret/state/useThread";
import { agentOf } from "@ret/agents";
import { Button, Icon, MONO } from "../ui/primitives";

/**
 * What the agent is waiting on you to allow, as the desktop's Approvals (components/thread/
 * Approvals.tsx): every choice answers with exactly what the desktop sends. Questions
 * (request_user_input) are answered in the dock on the composer instead.
 */
export function Approvals({ threadId }: { threadId: string }) {
  const reqs = useThread(
    threadId,
    (s) => Object.values(s.requests).filter((r) => r.threadId === threadId && r.method !== "item/tool/requestUserInput"),
    shallowEqual,
  );
  if (!reqs.length) return null;
  return (
    <ScrollView className="max-h-[55%] grow-0" contentContainerClassName="gap-2 px-3 pt-2" keyboardShouldPersistTaps="handled">
      {[...reqs]
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .map((r) => (
          <RequestCard key={r.key} req={r} />
        ))}
    </ScrollView>
  );
}

type Choice = { label: string; kind?: "primary" | "ghost" | "danger"; onPress: () => void };

function Card({ icon, title, tone = "amber", children, choices }: { icon: LucideIcon; title: ReactNode; tone?: "amber" | "accent"; children?: ReactNode; choices: Choice[] }) {
  return (
    <View className={`gap-2.5 rounded-xl border px-3.5 py-3 ${tone === "amber" ? "border-amber/45 bg-amber-soft" : "border-accent/45 bg-accent-soft"}`}>
      <View className="flex-row items-center gap-2">
        <Icon icon={icon} size={15} colorClassName={tone === "amber" ? "accent-amber" : "accent-accent"} />
        <Text className={`flex-1 text-[14px] font-semibold ${tone === "amber" ? "text-amber" : "text-accent"}`}>{title}</Text>
      </View>
      {children}
      <View className="flex-row flex-wrap gap-2">
        {choices.map((c) => (
          <Button
            key={c.label}
            label={c.label}
            kind={c.kind}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              c.onPress();
            }}
          />
        ))}
      </View>
    </View>
  );
}

const Reason = ({ children }: { children: ReactNode }) => <Text className="text-[14px] leading-5 text-text-2">{children}</Text>;

function Command({ text }: { text: string }) {
  return (
    <ScrollView className="max-h-40 rounded-lg border border-line bg-code-bg" nestedScrollEnabled>
      <Text selectable style={{ fontFamily: MONO }} className="px-3 py-2 text-[12.5px] leading-[18px] text-text">
        {text}
      </Text>
    </ScrollView>
  );
}

export function RequestCard({ req }: { req: PendingRequest }) {
  const p = req.params;
  const send = (result: unknown) => respondToRequest(req.key, result);

  switch (req.method) {
    case "item/commandExecution/requestApproval": {
      const amend = p.proposedExecpolicyAmendment as string[] | null | undefined;
      const net = p.networkApprovalContext as { host: string; protocol: string } | null | undefined;
      return (
        <Card
          icon={net ? Globe : SquareTerminal}
          title={net ? `Allow network access to ${net.host}?` : "Run this command?"}
          choices={[
            { label: "Run", kind: "primary", onPress: () => send({ decision: "accept" }) },
            { label: "Always this session", onPress: () => send({ decision: "acceptForSession" }) },
            ...(amend?.length
              ? [{ label: `Always allow “${amend.join(" ")}”`, onPress: () => send({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amend } } }) }]
              : []),
            { label: "Decline", kind: "ghost", onPress: () => send({ decision: "decline" }) },
            { label: "Stop turn", kind: "danger", onPress: () => send({ decision: "cancel" }) },
          ]}
        >
          {p.command ? <Command text={unwrapCommand(p.command)} /> : null}
          {p.reason ? <Reason>{p.reason}</Reason> : null}
        </Card>
      );
    }
    case "item/fileChange/requestApproval":
      return (
        <Card
          icon={FilePen}
          title="Apply these edits?"
          choices={[
            { label: "Apply", kind: "primary", onPress: () => send({ decision: "accept" }) },
            { label: "Always this session", onPress: () => send({ decision: "acceptForSession" }) },
            { label: "Decline", kind: "ghost", onPress: () => send({ decision: "decline" }) },
            { label: "Stop turn", kind: "danger", onPress: () => send({ decision: "cancel" }) },
          ]}
        >
          {p.reason ? <Reason>{p.reason}</Reason> : null}
          {p.grantRoot ? <Reason>Grants write access to {p.grantRoot}</Reason> : null}
        </Card>
      );
    case "item/permissions/requestApproval": {
      const perms = p.permissions ?? {};
      const granted: Record<string, unknown> = {};
      if (perms.network) granted.network = perms.network;
      if (perms.fileSystem) granted.fileSystem = perms.fileSystem;
      const lines = [
        ...(perms.network?.enabled ? ["Network access"] : []),
        ...((perms.fileSystem?.write as string[] | undefined)?.map((w) => `Write: ${w}`) ?? []),
        ...((perms.fileSystem?.read as string[] | undefined)?.map((r) => `Read: ${r}`) ?? []),
      ];
      return (
        <Card
          icon={ShieldAlert}
          title="Grant extra permissions?"
          choices={[
            { label: "Allow for turn", kind: "primary", onPress: () => send({ permissions: granted, scope: "turn" }) },
            { label: "Allow for session", onPress: () => send({ permissions: granted, scope: "session" }) },
            { label: "Deny", kind: "ghost", onPress: () => send({ permissions: {}, scope: "turn" }) },
          ]}
        >
          {p.reason ? <Reason>{p.reason}</Reason> : null}
          {lines.map((l) => (
            <Reason key={l}>• {l}</Reason>
          ))}
        </Card>
      );
    }
    case "item/tool/requestApproval": {
      const args = p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : null;
      const shown = args ? Object.entries(args).filter(([, v]) => v != null && v !== "") : [];
      return (
        <Card
          icon={Wrench}
          title={p.title ?? `Use ${p.server ? `${p.server} · ` : ""}${p.tool}?`}
          choices={[
            { label: "Allow", kind: "primary", onPress: () => send({ decision: "accept" }) },
            { label: "Always this session", onPress: () => send({ decision: "acceptForSession" }) },
            { label: "Decline", kind: "ghost", onPress: () => send({ decision: "decline" }) },
            { label: "Stop turn", kind: "danger", onPress: () => send({ decision: "cancel" }) },
          ]}
        >
          {p.description ? <Reason>{p.description}</Reason> : null}
          {shown.length > 0 && <Command text={shown.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n").slice(0, 2000)} />}
          {p.reason ? <Reason>{p.reason}</Reason> : null}
        </Card>
      );
    }
    case "mcpServer/elicitation/request":
      return isPermissionAsk(p) ? <PermissionAskCard req={req} /> : <ElicitationCard req={req} />;
    case "execCommandApproval":
    case "applyPatchApproval":
      return (
        <Card
          icon={req.method === "execCommandApproval" ? SquareTerminal : FilePen}
          title={req.method === "execCommandApproval" ? "Run this command?" : "Apply these edits?"}
          choices={[
            { label: "Approve", kind: "primary", onPress: () => send({ decision: "approved" }) },
            { label: "Always this session", onPress: () => send({ decision: "approved_for_session" }) },
            { label: "Deny", kind: "ghost", onPress: () => send({ decision: { denied: { rejection: "Declined by user" } } }) },
            { label: "Stop turn", kind: "danger", onPress: () => send({ decision: "abort" }) },
          ]}
        >
          {p.command ? <Command text={(p.command as string[]).join(" ")} /> : null}
          {p.reason ? <Reason>{p.reason}</Reason> : null}
        </Card>
      );
    default:
      return <Card icon={KeyRound} title={`Unsupported request: ${req.method}`} choices={[{ label: "Dismiss", onPress: () => send({}) }]} />;
  }
}

/** A tool asking before it acts: allow once, for the session, or always (which takes a second tap). */
function PermissionAskCard({ req }: { req: PendingRequest }) {
  const p = req.params;
  const persist = persistOffered(p);
  const app = appAskedFor(p);
  const details = displayParams(p._meta?.tool_params_display).filter((d) => !(app && d.name === "app"));
  const [sure, setSure] = useState(false);
  const host = hostOf(req.engine);
  const what = app ? appLabel(app, null, host) : "this tool";
  const agent = agentOf(req.engine).name;
  const send = (action: "accept" | "decline" | "cancel", remember?: "session" | "always") =>
    respondToRequest(req.key, { action, content: action === "accept" ? {} : null, _meta: remember ? { persist: remember } : null });
  return (
    <Card
      icon={KeyRound}
      title={app ? `Let ${agent} use ${what}?` : typeof p.message === "string" ? p.message : "Allow this tool?"}
      choices={[
        { label: "Allow", kind: "primary", onPress: () => send("accept") },
        ...(persist.session ? [{ label: "Always this session", onPress: () => send("accept", "session") }] : []),
        ...(persist.always ? [{ label: sure ? `Tap again to always allow ${what}` : `Always allow ${what}…`, onPress: () => (sure ? send("accept", "always") : setSure(true)) }] : []),
        { label: "Deny", kind: "ghost" as const, onPress: () => send("decline") },
        { label: "Stop turn", kind: "danger" as const, onPress: () => send("cancel") },
      ]}
    >
      {details.map((d) => (
        <Reason key={d.name}>
          {d.label}: {typeof d.value === "string" ? d.value : (JSON.stringify(d.value) ?? "")}
        </Reason>
      ))}
    </Card>
  );
}

/** A tool's form (MCP elicitation): fields to fill, or a link to open. */
function ElicitationCard({ req }: { req: PendingRequest }) {
  const p = req.params;
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const send = (action: "accept" | "decline" | "cancel", content: unknown = null) => respondToRequest(req.key, { action, content, _meta: null });
  const props: Record<string, any> = p.mode === "form" ? (p.requestedSchema?.properties ?? {}) : {};
  return (
    <Card
      icon={KeyRound}
      title={`${p.serverName} needs input`}
      choices={[
        p.mode === "url"
          ? {
              label: "Open link",
              kind: "primary",
              onPress: () => {
                void Linking.openURL(p.url);
                send("accept");
              },
            }
          : {
              label: "Submit",
              kind: "primary",
              onPress: () => {
                const content: Record<string, unknown> = {};
                for (const [k, schema] of Object.entries(props)) {
                  const v = values[k];
                  if (v === undefined || v === "") continue;
                  content[k] = schema.type === "number" || schema.type === "integer" ? Number(v) : v;
                }
                send("accept", content);
              },
            },
        { label: "Decline", kind: "ghost", onPress: () => send("decline") },
      ]}
    >
      <Reason>{p.message}</Reason>
      {Object.entries(props).map(([key, schema]) => (
        <View key={key} className="gap-1">
          <Text className="text-[13px] text-text-2">{schema.title ?? key}</Text>
          {schema.type === "boolean" ? (
            <Switch value={!!values[key]} onValueChange={(v) => setValues({ ...values, [key]: v })} />
          ) : schema.enum ? (
            <View className="flex-row flex-wrap gap-1.5">
              {(schema.enum as string[]).map((v, i) => (
                <Pressable
                  key={v}
                  onPress={() => setValues({ ...values, [key]: v })}
                  className={`rounded-lg border px-3 py-2 ${values[key] === v ? "border-accent bg-accent-soft" : "border-line bg-bg-2"}`}
                >
                  <Text className="text-[14px] text-text">{schema.enumNames?.[i] ?? v}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <TextInput
              className="h-10 rounded-lg border border-line bg-bg-2 px-3 text-[15px] text-text"
              value={String(values[key] ?? "")}
              onChangeText={(t) => setValues({ ...values, [key]: t })}
              keyboardType={schema.type === "number" || schema.type === "integer" ? "numeric" : "default"}
            />
          )}
        </View>
      ))}
    </Card>
  );
}

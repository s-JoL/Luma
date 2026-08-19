import { useEffect, useState } from "react";
import type { SecuritySettings } from "@shared/types.ts";
import { api, ApiError, type StepUp } from "../../api.ts";
import {
  Badge,
  Button,
  Empty,
  Field,
  formatTime,
  Input,
  Modal,
  Row,
  Section,
  SectionBody,
  useAction,
  useToast,
} from "../../ui.tsx";

/**
 * A change the server will not make on a session alone. It is held until the
 * owner has confirmed it, so the credentials are asked for once, in front of a
 * sentence naming what they are authorising — rather than as permanent fields
 * beside every button, which is the version nobody reads before typing into.
 */
interface Confirmable {
  title: string;
  detail: string;
  danger?: boolean;
  confirm: string;
  done: string;
  run: (step: StepUp) => Promise<void>;
}

export function SecuritySection() {
  const act = useAction();
  const toast = useToast();
  const [state, setState] = useState<SecuritySettings | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Confirmable | null>(null);

  useEffect(() => {
    void api
      .security()
      .then(setState)
      .catch((error: unknown) => toast(String(error), true));
  }, [toast]);

  if (!state) return <Empty>正在加载…</Empty>;

  return (
    <>
      <Section
        title="访问码"
        hint="访问码是第一道门。修改后，除当前设备外的所有会话都会失效。"
        actions={<Badge tone={state.overTls ? "success" : "warning"}>{state.overTls ? "HTTPS" : "明文 HTTP"}</Badge>}
      >
        <SectionBody>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              type="password"
              placeholder="新的访问码（至少 12 位）"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
            />
            <Button
              disabled={accessCode.trim().length < 12}
              onClick={() =>
                setPending({
                  title: "修改访问码",
                  detail: "确认后访问码立即更换，其他设备需要用新的访问码重新登录。",
                  confirm: "修改访问码",
                  done: "访问码已更新",
                  run: async (step) => {
                    setState(await api.setAccessCode(accessCode.trim(), step));
                    setAccessCode("");
                  },
                })
              }
            >
              保存
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            至少 12 位。这是整个互联网都能猜的一道门，越长越好，建议用密码管理器生成。
          </p>
          {state.overTls ? null : (
            <p className="text-xs text-muted-foreground">
              当前是明文连接。对外暴露前请走 Cloudflare Tunnel 或其他 HTTPS 入口，否则访问码会在链路上以明文传输。
            </p>
          )}
        </SectionBody>
      </Section>

      <Section
        title="两步验证"
        actions={<Badge tone={state.totpEnabled ? "success" : "warning"}>{state.totpEnabled ? "已开启" : "未开启"}</Badge>}
      >
        <SectionBody>
          {state.totpEnabled ? (
            <>
              <p className="text-xs text-muted-foreground">
                登录时需要访问码加验证器动态码。关闭同样需要访问码和一个当前有效的动态码。
              </p>
              <div>
                <Button
                  variant="danger"
                  onClick={() =>
                    setPending({
                      title: "关闭两步验证",
                      detail: "关闭后，只要拿到访问码就能登录。",
                      danger: true,
                      confirm: "关闭两步验证",
                      done: "已关闭两步验证",
                      run: async (step) => setState(await api.disableTotp(step)),
                    })
                  }
                >
                  关闭
                </Button>
              </div>
            </>
          ) : enrolment ? (
            <>
              <p className="text-xs text-muted-foreground">
                在验证器里添加下面的密钥，然后输入它生成的动态码完成绑定。绑定成功前不会启用，不会把你自己锁在门外。
              </p>
              <Field label="密钥">
                <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all">
                  {enrolment.secret}
                </code>
              </Field>
              <Field label="otpauth 链接（支持扫码的客户端可直接粘贴）">
                <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all">
                  {enrolment.uri}
                </code>
              </Field>
              <div className="flex gap-2">
                <Input
                  className="max-w-40"
                  placeholder="6 位动态码"
                  inputMode="numeric"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={code.trim().length < 6}
                  onClick={async () => {
                    const ok = await act(async () => setState(await api.confirmTotp(code.trim())), "两步验证已开启");
                    if (ok) {
                      setCode("");
                      setEnrolment(null);
                    }
                  }}
                >
                  完成绑定
                </Button>
                <Button onClick={() => setEnrolment(null)}>取消</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                开启后，即使访问码泄露，没有你手机上的动态码也进不来。建议对外暴露时开启。
              </p>
              <div>
                <Button
                  variant="primary"
                  onClick={() =>
                    setPending({
                      title: "开始绑定验证器",
                      detail: "确认后会生成一个新的密钥，扫码并回填动态码才真正启用。",
                      confirm: "生成密钥",
                      done: "密钥已生成，请完成绑定",
                      run: async (step) => setEnrolment(await api.startTotp(step)),
                    })
                  }
                >
                  开始绑定
                </Button>
              </div>
            </>
          )}
        </SectionBody>
      </Section>

      <Section
        title={`登录设备（${state.sessions.length}）`}
        actions={
          <Button
            size="sm"
            disabled={state.sessions.length < 2}
            onClick={() =>
              setPending({
                title: "注销其他设备",
                detail: `除当前设备外的 ${state.sessions.length - 1} 个会话会立即失效。`,
                danger: true,
                confirm: "全部注销",
                done: "已注销其他设备",
                run: async (step) => setState(await api.revokeOtherSessions(step)),
              })
            }
          >
            注销其他设备
          </Button>
        }
      >
        {state.sessions.map((session) => (
          <Row key={session.id}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <strong className="truncate text-sm">{session.device}</strong>
                {session.id === state.currentSessionId ? <Badge tone="success">当前设备</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                登录于 {formatTime(session.createdAt)} · 最近活跃 {formatTime(session.lastSeen)}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={session.id === state.currentSessionId}
              onClick={() =>
                setPending({
                  title: "注销这台设备",
                  detail: `${session.device}，最近活跃 ${formatTime(session.lastSeen)}。`,
                  danger: true,
                  confirm: "注销",
                  done: "已注销",
                  run: async (step) => setState(await api.revokeSession(session.id, step)),
                })
              }
            >
              注销
            </Button>
          </Row>
        ))}
      </Section>

      <Section
        title="对外访问"
        actions={
          <Badge tone={state.trustProxy ? "success" : "outline"}>
            {state.trustProxy ? "已信任反向代理" : "仅本机地址"}
          </Badge>
        }
      >
        <SectionBody>
          <p className="text-xs text-muted-foreground">
            推荐用 Cloudflare Tunnel 暴露：本机不开任何公网端口，由 Cloudflare Access 先做一层身份校验，Luma
            的访问码与两步验证是第二层。具体命令见仓库里的 docs/06-remote-access.md。
          </p>
          <p className="text-xs text-muted-foreground">
            走反向代理时，把 LUMA_TRUST_PROXY 设为 1：登录限速才能按真实来源 IP
            统计，本页也才能分辨这次连接是 HTTPS 还是明文。没有它，隧道后面的每个请求看起来都来自本机，会共用同一份额度。
          </p>
        </SectionBody>
      </Section>

      <StepUpConfirm
        request={pending}
        totpRequired={state.totpEnabled}
        onClose={() => setPending(null)}
        onDone={(message) => {
          setPending(null);
          toast(message);
        }}
      />
    </>
  );
}

/**
 * The one place a locked-out owner cannot recover from, so a wrong code never
 * closes this: `step_up_required` and `bad_step_up` both re-prompt in place
 * with the fields kept, and only an unrelated failure falls through to a toast.
 */
function StepUpConfirm({
  request,
  totpRequired,
  onClose,
  onDone,
}: {
  request: Confirmable | null;
  totpRequired: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const toast = useToast();
  const [accessCode, setAccessCode] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAccessCode("");
    setTotp("");
    setError("");
  }, [request]);

  const ready = accessCode.trim().length > 0 && (!totpRequired || totp.trim().length >= 6);

  const submit = async () => {
    if (!request || !ready || busy) return;
    setBusy(true);
    try {
      await request.run({ accessCode: accessCode.trim(), totp: totp.trim() });
      onDone(request.done);
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === "step_up_required" || caught.code === "bad_step_up")) {
        setError(
          caught.code === "bad_step_up"
            ? totpRequired
              ? "访问码或动态码不对。动态码每 30 秒一换，请用最新的一个。"
              : "访问码不对，请重新输入。"
            : totpRequired
              ? "这一步需要访问码和验证器动态码。"
              : "这一步需要访问码。",
        );
        // The code just typed is either wrong or already spent; the next attempt
        // needs a fresh one either way.
        setTotp("");
      } else if (caught instanceof ApiError && caught.code === "too_many_attempts") {
        setError(caught.message);
      } else {
        toast(caught instanceof Error ? caught.message : String(caught), true);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(request)}
      onOpenChange={(open) => {
        // Escape and the backdrop are both closes; a confirmation already on its
        // way is not something to walk away from half-answered.
        if (!open && !busy) onClose();
      }}
      title={request?.title ?? ""}
      description={request?.detail}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant={request?.danger ? "danger" : "primary"} disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "确认中…" : (request?.confirm ?? "确认")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          这类改动会比当前登录活得更久，所以要再确认一次身份：只有一个会话 cookie 是不够的。
        </p>
        <Field label="访问码">
          <Input
            autoFocus
            type="password"
            autoComplete="current-password"
            placeholder="当前访问码"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </Field>
        {totpRequired ? (
          <Field label="验证器动态码" hint="验证器上当前显示的 6 位数字，用过一次就不能再用。">
            <Input
              className="max-w-40"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6 位动态码"
              value={totp}
              onChange={(event) => setTotp(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </Field>
        ) : null}
        {/* Below both fields rather than beside one: a refusal never says which
            half was wrong, and neither should this. */}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

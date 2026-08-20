import {
  Check,
  ChevronDown,
  Copy,
  CornerDownLeft,
  FileText,
  ImageIcon,
  Menu as MenuIcon,
  Paperclip,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Approval, Bootstrap, FileRecord, Profile, StoredMessage } from "@shared/types.ts";
import { isChatKind } from "@shared/types.ts";
import { api, followRun } from "../api.ts";
import { askToNotify, notifyFinished } from "../notify.ts";
import { assetIdOf, ProvenanceCard } from "../provenance.tsx";
import { Markdown, prefetchKatex } from "../markdown.tsx";
import {
  attachmentIdsOf,
  buildTurns,
  collectCitations,
  LiveTurn,
  toolCallIds,
  turnText,
  type Citation,
  type FilePart,
  type Turn,
} from "../messages.ts";
import {
  Badge,
  Button,
  cn,
  Field,
  formatBytes,
  JobCard,
  Lightbox,
  Modal,
  Select,
  Spinner,
  Textarea,
  Tooltip,
  useToast,
  useTouchPrimary,
  VideoView,
} from "../ui.tsx";

interface Props {
  bootstrap: Bootstrap;
  conversationId: string;
  /** A search hit's message: the transcript opens there instead of at the end. */
  focusSeq?: number;
  onConversationCreated: (id: string) => Promise<void>;
  onConversationChanged: () => Promise<unknown>;
  onOpenRail: () => void;
}

export function Chat({
  bootstrap,
  conversationId,
  focusSeq,
  onConversationCreated,
  onConversationChanged,
  onOpenRail,
}: Props) {
  const toast = useToast();
  const touch = useTouchPrimary();
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [live, setLive] = useState<Turn | null>(null);
  const [pendingUser, setPendingUser] = useState<Turn | null>(null);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<FileRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState("");
  const [title, setTitle] = useState("");
  const [modelId, setModelId] = useState(bootstrap.defaultModelId);
  const [profileId, setProfileId] = useState(bootstrap.defaultProfileId);
  /** Phone-only sheet for the two pickers the header cannot fit. */
  const [picking, setPicking] = useState(false);
  const [editingSeq, setEditingSeq] = useState<number | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Creating a conversation navigates onto its id, which re-runs the load
   * effect. Without this flag that effect would drop the optimistic user turn
   * and flash the empty state while the first run is already in flight.
   */
  const seedingRef = useRef(false);
  /** The turn currently being streamed, so a late fetch can tell if it is stale. */
  const liveTurnRef = useRef<LiveTurn | null>(null);
  const stickyRef = useRef(true);
  /** Highest message seq already rendered, so reloads only fetch the tail. */
  const messageSeqRef = useRef(-1);
  /** Conversation the transcript on screen belongs to, for late-arriving fetches. */
  const openConversationRef = useRef(conversationId);
  const messagesRef = useRef<StoredMessage[]>([]);
  messagesRef.current = messages;

  useEffect(prefetchKatex, []);

  const chatModels = useMemo(
    () => bootstrap.models.filter((model) => model.enabled && model.configured && isChatKind(model.kind)),
    [bootstrap.models],
  );
  /**
   * The switcher lists pinned models only — the dropdown is for the few you
   * actually reach for. With nothing pinned that list is empty and there would
   * be no way to choose at all, so it falls back to everything usable.
   */
  const listedModels = useMemo(() => {
    const pinned = chatModels.filter((model) => model.pinned);
    return pinned.length ? pinned : chatModels;
  }, [chatModels]);
  const current = bootstrap.models.find((model) => model.id === modelId);
  const profile = bootstrap.profiles.find((item) => item.id === profileId);

  const syncMessages = useCallback(async (id: string, incremental: boolean) => {
    const from = incremental ? messageSeqRef.current : -1;
    const log = await api.messages(id, from);
    // Switching conversations quickly leaves the previous fetch in flight, and
    // it resolves after the new one. Without this guard the old transcript is
    // painted under the new conversation's title and stays until a reload.
    if (openConversationRef.current !== id) return messagesRef.current;
    messageSeqRef.current = Math.max(from, ...log.items.map((item) => item.seq));
    const merged = from >= 0 ? [...messagesRef.current, ...log.items] : log.items;
    messagesRef.current = merged;
    setMessages(merged);
    return merged;
  }, []);

  /**
   * Picks up a run that is still going on the server — after a reload, or on a
   * second device. The transcript already holds the settled messages, so the
   * stream is replayed from the run's resume point.
   */
  const follow = useCallback(
    async (id: string, runId: string, from: number, known: Set<string>) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const turn = new LiveTurn(known);
      liveTurnRef.current = turn;
      setRunning(true);
      setLive(turn.snapshot());
      // A question asked while this client was closed has no event left to
      // replay if the run resumes past it, so it is fetched rather than waited
      // for. Seeding is idempotent with the stream.
      void api
        .approvals(id)
        .then(({ items }) => {
          if (liveTurnRef.current !== turn || !items.length) return;
          turn.seedApprovals(items.filter((item) => item.runId === runId));
          setLive(turn.snapshot());
        })
        .catch(() => undefined);
      try {
        await followRun(
          runId,
          from,
          (type, data) => {
            turn.apply(type, data);
            if (type === "conversation.title") {
              setTitle(String(data.title ?? ""));
              void onConversationChanged();
            }
            if (type === "run.failed") toast(String(data.message ?? "运行失败"), true);
            setLive(turn.snapshot());
          },
          controller.signal,
        );
      } finally {
        // Another conversation may have been opened while this leg was running;
        // its own effect owns the screen now.
        if (abortRef.current === controller && openConversationRef.current === id) {
          abortRef.current = null;
          setRunning(false);
          // A turn that drew three pictures took minutes, and the reader has
          // usually gone elsewhere by the time it lands.
          notifyFinished("回复完成", turnText(turn.snapshot()).trim().slice(0, 120));
          // The live turn is only swapped for the stored transcript once that
          // transcript is actually in hand; dropping it while the network is
          // down would blank an answer the reader was in the middle of.
          const synced = await syncMessages(id, true).then(
            () => true,
            () => false,
          );
          if (synced) {
            setPendingUser(null);
            setLive(null);
          }
          await onConversationChanged().catch(() => undefined);
        }
      }
    },
    [onConversationChanged, syncMessages, toast],
  );

  useEffect(() => {
    if (!seedingRef.current) {
      abortRef.current?.abort();
      abortRef.current = null;
      setLive(null);
      setPendingUser(null);
      setRunning(false);
      messageSeqRef.current = -1;
      messagesRef.current = [];
      setMessages([]);
    }
    openConversationRef.current = conversationId;
    setEditingSeq(null);
    if (!conversationId) {
      setTitle("");
      setProfileId(bootstrap.defaultProfileId);
      return;
    }
    if (seedingRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const [summary, log] = await Promise.all([
          api.conversation(conversationId),
          syncMessages(conversationId, false),
        ]);
        if (cancelled) return;
        setTitle(summary.title);
        setModelId(summary.modelId);
        setProfileId(summary.profileId);
        if (summary.activeRun) {
          void follow(
            conversationId,
            summary.activeRun.id,
            summary.activeRun.resumeSeq ?? 0,
            toolCallIds(buildTurns(log)),
          );
        }
      } catch (error) {
        if (!cancelled) toast(error instanceof Error ? error.message : String(error), true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrap.defaultProfileId, conversationId, follow, syncMessages, toast]);

  /**
   * A phone can be asleep long enough for the stream loop to give up, and it
   * wakes with no network for a moment. Every return to the foreground — and
   * every reconnect — re-reads the transcript and reattaches to a run that is
   * still going, so recovery never depends on the dropped connection.
   */
  useEffect(() => {
    if (!conversationId) return;
    const resync = () => {
      if (document.visibilityState !== "visible" || abortRef.current) return;
      void (async () => {
        try {
          const [summary, log] = await Promise.all([
            api.conversation(conversationId),
            syncMessages(conversationId, true),
          ]);
          if (abortRef.current) return;
          setTitle(summary.title);
          if (summary.activeRun) {
            void follow(
              conversationId,
              summary.activeRun.id,
              summary.activeRun.resumeSeq ?? 0,
              toolCallIds(buildTurns(log)),
            );
          } else {
            setPendingUser(null);
            setLive(null);
            setRunning(false);
          }
        } catch {
          // Still offline; the next visibility or online event tries again.
        }
      })();
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
    };
  }, [conversationId, follow, syncMessages]);

  // Keep the view pinned to the newest output unless the reader scrolled up.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread && stickyRef.current) thread.scrollTop = thread.scrollHeight;
  }, [messages, live, pendingUser]);

  /**
   * An image decodes after the turn holding it has rendered, and the height it
   * then claims shoves the newest output back off screen: the effect above has
   * already run, and a layout change is not a state change that would run it
   * again. A transcript records image ids and no dimensions, so there is nothing
   * to reserve the space with in advance — the correction is made when the
   * content resizes, which is the moment the picture takes its place.
   */
  const contentResize = useRef<ResizeObserver | null>(null);
  const watchContent = useCallback((node: HTMLDivElement | null) => {
    contentResize.current?.disconnect();
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const thread = threadRef.current;
      if (thread && stickyRef.current) thread.scrollTop = thread.scrollHeight;
    });
    observer.observe(node);
    contentResize.current = observer;
  }, []);

  const turns = useMemo(() => buildTurns(messages), [messages]);

  /**
   * Opening a conversation from a search hit lands on the matching message
   * instead of at the end. A turn owns the sequence of its first message, so the
   * hit belongs to the last turn that starts at or before it.
   */
  useEffect(() => {
    if (focusSeq === undefined) return;
    const target = turns.filter((turn) => turn.seq <= focusSeq).at(-1);
    const element = target ? threadRef.current?.querySelector(`[data-seq="${target.seq}"]`) : undefined;
    if (!element) return;
    // Otherwise the pin-to-newest effect drags the view straight back down.
    stickyRef.current = false;
    element.scrollIntoView({ block: "center" });
    element.classList.add("ring-2", "ring-ring/60", "rounded-lg");
    const timer = setTimeout(() => element.classList.remove("ring-2", "ring-ring/60", "rounded-lg"), 2_000);
    return () => clearTimeout(timer);
  }, [focusSeq, turns]);

  /**
   * Citations only ever come out of tool results, but `live` is a new object on
   * every token. Keying the merge on the live tool results alone keeps this Map
   * referentially stable through a stream, which is what stops every settled
   * turn in the transcript from re-parsing its Markdown on each delta.
   */
  const settledCitations = useMemo(() => collectCitations(turns), [turns]);
  const liveRef = useRef<Turn | null>(null);
  liveRef.current = live;
  const liveToolState = live
    ? live.parts.map((part) => (part.kind === "tool" ? `${part.callId}:${part.result.length}` : "")).join("|")
    : "";
  const citations = useMemo(() => {
    const turn = liveRef.current;
    if (!turn || !liveToolState.replace(/\|/g, "")) return settledCitations;
    return new Map([...settledCitations, ...collectCitations([turn])]);
  }, [settledCitations, liveToolState]);

  const attach = async (files: FileList | File[]) => {
    // The cap is on the message, not on one drop, so what is already attached
    // has to come off the budget before anything else is uploaded.
    const cap = bootstrap.limits.maxAttachmentsPerMessage;
    const room = cap - attachments.length;
    const incoming = Array.from(files);
    if (room <= 0) {
      toast(`一条消息最多附带 ${cap} 个附件，请先移除一些`, true);
      return;
    }
    if (incoming.length > room) {
      toast(`一条消息最多附带 ${cap} 个附件，其余 ${incoming.length - room} 个未添加`, true);
    }
    setUploading(true);
    try {
      for (const file of incoming.slice(0, room)) {
        if (file.size > bootstrap.limits.maxUploadBytes) {
          toast(`${file.name} 超过上传大小上限`, true);
          continue;
        }
        const record = await api.upload(file, conversationId || undefined);
        setAttachments((current) => [...current, record]);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || running) return;
    if (!chatModels.length) {
      toast("先在设置里配置一个可用模型", true);
      return;
    }

    let targetId = conversationId;
    setRunning(true);
    // Sending is the gesture a permission prompt needs behind it.
    askToNotify();
    stickyRef.current = true;
    setPendingUser({
      id: "pending",
      seq: -1,
      role: "user",
      parts: [
        { kind: "text", text },
        ...attachments.map((file) =>
          file.mime.startsWith("image/")
            ? ({ kind: "image", imageId: file.id } as const)
            : ({ kind: "file", fileId: file.id, name: file.name, bytes: file.bytes } as const),
        ),
      ],
    });
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const attachmentIds = attachments.map((file) => file.id);
    setAttachments([]);
    try {
      if (!targetId) {
        seedingRef.current = true;
        const created = await api.createConversation(modelId, profileId);
        targetId = created.id;
        await onConversationCreated(created.id);
        seedingRef.current = false;
      }

      const run = await api.startRun(targetId, text, attachmentIds, modelId);
      await follow(targetId, run.runId, run.seq, new Set());
    } catch (error) {
      seedingRef.current = false;
      setRunning(false);
      setPendingUser(null);
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  /**
   * Replays a user turn: the server drops it and everything after, then runs
   * the text below in its place. Regenerating passes the original text, so the
   * two actions are the same operation with a different string.
   */
  const replay = async (turn: Turn, text: string) => {
    if (!conversationId || running || !text.trim()) return;
    setRunning(true);
    setEditingSeq(null);
    stickyRef.current = true;
    // The rewind invalidates every seq the client has cached.
    messageSeqRef.current = -1;
    messagesRef.current = messagesRef.current.filter((message) => message.seq < turn.seq);
    setMessages(messagesRef.current);
    const attached = turn.parts.filter((part) => part.kind !== "text" && part.kind !== "thinking");
    setPendingUser({
      ...turn,
      id: "pending",
      parts: [{ kind: "text", text }, ...attached],
    });
    try {
      const run = await api.startRun(conversationId, text, attachmentIdsOf(turn), modelId, turn.seq);
      await follow(conversationId, run.runId, run.seq, new Set());
    } catch (error) {
      setRunning(false);
      setPendingUser(null);
      toast(error instanceof Error ? error.message : String(error), true);
      await syncMessages(conversationId, false).catch(() => undefined);
    }
  };

  const resume = async () => {
    if (!conversationId || running) return;
    setRunning(true);
    stickyRef.current = true;
    try {
      const run = await api.continueRun(conversationId);
      await follow(conversationId, run.runId, run.seq, new Set());
    } catch (error) {
      setRunning(false);
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const stop = async () => {
    if (!conversationId) return;
    try {
      await api.stopRun(conversationId);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const visibleTurns = [...turns, ...(pendingUser ? [pendingUser] : []), ...(live ? [live] : [])];
  // Rewinding mid-run would race the run that is writing the transcript, and
  // only the newest answer has anything meaningful to continue from.
  const lastUserTurn = turns.filter((turn) => turn.role === "user").at(-1);
  const canAct = Boolean(conversationId) && !running && !pendingUser && !live;

  // What the reader can actually count on this turn, named rather than implied.
  // Generation is a model question, not a settings flag: a profile's image model
  // is what decides whether pictures are on the table.
  const generates = bootstrap.models.some(
    (model) => (model.kind === "image" || model.kind === "video") && model.enabled && model.configured,
  );
  const enabled = [
    bootstrap.capabilities.web.enabled ? "联网搜索" : "",
    bootstrap.capabilities.files.enabled ? "文件检索" : "",
    bootstrap.capabilities.memory.enabled ? "记忆" : "",
    generates ? "图像与视频" : "",
  ].filter(Boolean);

  // The conversation's own model is always an option, even when it is unpinned
  // or no longer in the catalogue, so the control never shows a blank trigger.
  const modelOptions = [
    ...(modelId && !listedModels.some((model) => model.id === modelId)
      ? [{ value: modelId, label: current?.name ?? modelId, hint: current ? "未固定" : "当前模型" }]
      : []),
    ...listedModels.map((model) => ({
      value: model.id,
      label: model.name,
      hint: model.providerId,
    })),
  ];

  const chooseProfile = async (next: string) => {
    setProfileId(next);
    const chat = bootstrap.profiles.find((item) => item.id === next)?.chatModelId;
    if (chat && bootstrap.models.some((model) => model.id === chat && model.enabled)) setModelId(chat);
    if (conversationId) await api.setConversationProfile(conversationId, next).catch(() => undefined);
  };

  const chooseModel = async (next: string) => {
    setModelId(next);
    if (conversationId) await api.setConversationModel(conversationId, next).catch(() => undefined);
  };

  // Rendered both in the header and, on a phone, inside the sheet below, which
  // is why the width comes from the caller.
  const profileSelect = (className: string) =>
    bootstrap.profiles.length ? (
      <Select
        value={profileId}
        className={className}
        placeholder="默认设置"
        triggerLabel={profile?.name ?? "默认设置"}
        options={[
          { value: "", label: "默认设置", hint: "使用全局模型与能力" },
          ...bootstrap.profiles.map((item) => ({
            value: item.id,
            label: item.name,
            hint: describeProfile(item, bootstrap),
          })),
        ]}
        onChange={(next) => void chooseProfile(next)}
      />
    ) : null;

  const modelSelect = (className: string) => (
    <Select
      value={modelId}
      className={className}
      placeholder="未配置模型"
      options={modelOptions}
      onChange={(next) => void chooseModel(next)}
    />
  );

  return (
    <>
      <header className="flex h-13 shrink-0 items-center gap-2 border-b px-2 md:px-3">
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="菜单" onClick={onOpenRail}>
          <MenuIcon />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium md:text-base">{title || "新对话"}</h1>

        {/* On a phone the two pickers would leave the title a few characters
            wide, so there they move behind one button. */}
        <div className="hidden items-center gap-2 sm:flex">
          {profileSelect("h-8 max-w-40 text-sm")}
          {modelSelect("h-8 max-w-44 text-sm")}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          aria-label="本次对话的模型与预设"
          onClick={() => setPicking(true)}
        >
          <SlidersHorizontal />
        </Button>

        {running ? (
          <Button variant="danger" size="sm" onClick={() => void stop()}>
            <Square />
            停止
          </Button>
        ) : null}
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        ref={threadRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickyRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        }}
      >
        {visibleTurns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-lg font-medium">开始一段新对话</p>
            <p className="max-w-md text-sm text-muted-foreground">搜网页、查文件、画图、做视频，都行。</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" ref={watchContent}>
            {visibleTurns.map((turn, index) => (
              <TurnView
                key={`${turn.id}-${index}`}
                turn={turn}
                citations={citations}
                streaming={running && turn === live}
                onImageClick={setZoom}
                editing={turn.role === "user" && turn.seq === editingSeq}
                onEdit={canAct && turn.role === "user" ? () => setEditingSeq(turn.seq) : undefined}
                onCancelEdit={() => setEditingSeq(null)}
                onSubmitEdit={(text) => void replay(turn, text)}
                onRegenerate={
                  canAct && lastUserTurn && turn === visibleTurns.at(-1) && turn.role === "assistant"
                    ? () => void replay(lastUserTurn, turnText(lastUserTurn))
                    : undefined
                }
                onContinue={canAct && turn === visibleTurns.at(-1) && turn.role === "assistant" ? resume : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <div
          className={cn(
            "mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-xl border bg-card p-2 transition-colors",
            dragging && "border-primary bg-accent/40",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length) void attach(event.dataTransfer.files);
          }}
        >
          {attachments.length ? (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((file) => (
                <span
                  key={file.id}
                  className="flex items-center gap-1.5 rounded-md bg-secondary py-1 pr-1 pl-2 text-xs"
                >
                  {file.mime.startsWith("image/") ? (
                    <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="max-w-40 truncate">{file.name}</span>
                  <span className="text-muted-foreground">{formatBytes(file.bytes)}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    aria-label={`移除 ${file.name}`}
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}
                  >
                    <X />
                  </Button>
                </span>
              ))}
            </div>
          ) : null}

          <Textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            data-testid="composer-input"
            enterKeyHint={touch ? "enter" : "send"}
            className="max-h-55 min-h-9 resize-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0"
            placeholder={touch ? "输入消息，点右下角发送" : "输入消息，Enter 发送，Shift+Enter 换行"}
            onChange={(event) => {
              setDraft(event.target.value);
              const element = event.target;
              element.style.height = "auto";
              element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                void attach(files);
              }
            }}
            onKeyDown={(event) => {
              // On a touch keyboard Enter is the only way to reach a newline,
              // so it must never be stolen; sending is the button's job there.
              if (touch) return;
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />

          <div className="flex items-center gap-2">
            <Tooltip label="添加附件">
              <label className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <Paperclip className="size-4" />
                {/* `sr-only` rather than `hidden`: a hidden input is out of the
                    accessibility tree, which leaves the control unreachable by
                    keyboard since the label cannot take focus itself. */}
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="添加附件"
                  onChange={(event) => {
                    if (event.target.files?.length) void attach(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
            </Tooltip>
            {uploading ? <Spinner className="text-muted-foreground" /> : null}
            <span className="flex-1" />
            <Button
              variant="primary"
              size="sm"
              data-testid="composer-send"
              disabled={!draft.trim() || running}
              onClick={() => void send()}
            >
              {running ? <Spinner /> : <CornerDownLeft />}
              {running ? "生成中" : "发送"}
            </Button>
          </div>
        </div>

        <p className="mx-auto mt-2 max-w-3xl truncate text-center text-xs text-muted-foreground">
          {enabled.join(" · ") || "尚未开启任何能力，可在设置里打开"}
        </p>
      </div>

      <Modal open={picking} onOpenChange={setPicking} title="本次对话" description="只影响这个对话">
        <div className="flex flex-col gap-4">
          {bootstrap.profiles.length ? <Field label="预设">{profileSelect("w-full")}</Field> : null}
          <Field label="模型">{modelSelect("w-full")}</Field>
        </div>
      </Modal>

      {zoom ? (
        <Lightbox
          src={zoom}
          onClose={() => setZoom("")}
          aside={assetIdOf(zoom) ? <ProvenanceCard assetId={assetIdOf(zoom)} /> : undefined}
        />
      ) : null}
    </>
  );
}

/** What picking this profile actually changes, in one line under its name. */
function describeProfile(profile: Profile, bootstrap: Bootstrap) {
  const model = bootstrap.models.find((item) => item.id === profile.chatModelId);
  const on = Object.entries(profile.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([key]) => CAPABILITY_LABELS[key] ?? key);
  return [model?.name, on.join("·")].filter(Boolean).join(" · ");
}

const CAPABILITY_LABELS: Record<string, string> = {
  memory: "记忆",
  files: "文件",
  web: "联网",
  coding: "编码",
  skills: "技能",
  generation: "生成",
};

const TurnView = memo(function TurnView({
  turn,
  citations,
  streaming,
  onImageClick,
  editing,
  onEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onContinue,
}: {
  turn: Turn;
  citations: Map<string, Citation>;
  streaming: boolean;
  onImageClick: (src: string) => void;
  editing: boolean;
  onEdit?: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  onContinue?: () => void;
}) {
  if (turn.role === "user") {
    const images = turn.parts.filter((part) => part.kind === "image");
    const documents = turn.parts.filter((part) => part.kind === "file");
    const text = turnText(turn);
    return (
      <div className="group flex flex-col items-end gap-2" data-seq={turn.seq} data-testid="turn">
        {images.length ? (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((part) => (
              <img
                key={part.imageId}
                className="max-h-50 max-w-50 cursor-zoom-in rounded-lg border object-cover"
                src={`/v1/images/${part.imageId}?w=320`}
                alt=""
                loading="lazy"
                decoding="async"
                onClick={() => onImageClick(`/v1/images/${part.imageId}`)}
              />
            ))}
          </div>
        ) : null}
        {documents.length ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {documents.map((part) => (
              <FileChip key={part.fileId} part={part} />
            ))}
          </div>
        ) : null}
        {editing ? (
          <MessageEditor text={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
        ) : (
          <>
            {text ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 whitespace-pre-wrap text-primary-foreground">
                {text}
              </div>
            ) : null}
            {onEdit ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={onEdit}
              >
                <Pencil />
                编辑
              </Button>
            ) : null}
          </>
        )}
      </div>
    );
  }

  const empty = turn.parts.length === 0;
  return (
    <div className="group flex flex-col gap-3" data-seq={turn.seq} data-testid="turn">
      {turn.parts.map((part, index) => {
        if (part.kind === "text") {
          return (
            <Markdown
              key={index}
              text={part.text}
              citations={citations}
              streaming={streaming && index === turn.parts.length - 1}
              onImageClick={onImageClick}
            />
          );
        }
        if (part.kind === "thinking") {
          return (
            <details key={index} className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground select-none">思考过程</summary>
              <div className="mt-2 whitespace-pre-wrap text-muted-foreground">{part.text}</div>
            </details>
          );
        }
        if (part.kind === "image") {
          return (
            <img
              key={index}
              className="max-h-150 w-fit max-w-full cursor-zoom-in rounded-lg border"
              src={`/v1/images/${part.imageId}?w=1280`}
              alt=""
              loading="lazy"
              decoding="async"
              onClick={() => onImageClick(`/v1/images/${part.imageId}`)}
            />
          );
        }
        if (part.kind === "video") {
          return (
            <VideoView
              key={index}
              className="max-h-150"
              videoId={part.videoId}
              posterImageId={part.posterImageId}
              durationMs={part.durationMs}
            />
          );
        }
        if (part.kind === "file") {
          return <FileChip key={index} part={part} />;
        }
        if (part.kind === "approval") {
          return <ApprovalView key={part.approval.id} approval={part.approval} />;
        }
        // Cancelling here would fail the tool call that is waiting on the job,
        // so the card watches without offering a way out of the turn.
        if (part.kind === "job") {
          return <JobCard key={part.jobId} job={part.job} onZoom={onImageClick} />;
        }
        return <ToolView key={index} part={part} />;
      })}

      {empty && streaming ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          正在思考…
        </div>
      ) : null}
      {turn.error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {turn.error}
        </p>
      ) : null}

      {onRegenerate || onContinue ? (
        <div className="flex items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onRegenerate ? (
            <Button variant="ghost" size="sm" onClick={onRegenerate}>
              <RefreshCw />
              重新生成
            </Button>
          ) : null}
          {onContinue ? (
            <Button variant="ghost" size="sm" onClick={onContinue}>
              继续
            </Button>
          ) : null}
          <CopyButton text={turnText(turn)} />
        </div>
      ) : null}
    </div>
  );
});

/**
 * An attachment with nothing to preview. The name is all there is to recognise
 * it by, and the link is the only way back to the bytes the turn was given.
 */
function FileChip({ part }: { part: FilePart }) {
  return (
    <a
      className="flex w-fit items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs transition-colors hover:bg-secondary/70"
      href={`/v1/files/${part.fileId}/content`}
      download={part.name}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-50 truncate">{part.name}</span>
      {part.bytes ? <span className="text-muted-foreground">{formatBytes(part.bytes)}</span> : null}
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1_200);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "已复制" : "复制"}
    </Button>
  );
}

function MessageEditor({
  text,
  onCancel,
  onSubmit,
}: {
  text: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const touch = useTouchPrimary();

  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        value={draft}
        autoFocus
        rows={Math.min(12, draft.split("\n").length + 1)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (touch) return;
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit(draft);
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">这条之后的回答会被重新生成</span>
        <Button size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={() => onSubmit(draft)}>
          保存并重新生成
        </Button>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  delete: "删除文件",
  delete_recursive: "递归删除",
  overwrite: "覆盖文件",
  move: "移动文件",
  move_overwrite: "移动并覆盖",
  shell: "运行命令",
};

const DETAIL_LABELS: Record<string, string> = {
  path: "路径",
  from: "源",
  to: "目标",
  files: "文件数",
  bytes: "大小",
  currentBytes: "当前大小",
  newBytes: "写入大小",
  command: "命令",
  workspace: "工作区",
  reason: "原因",
};

/**
 * The question itself. It is deliberately not a modal: the reader needs the
 * tool calls above it to judge what the model is doing, and a dialog that
 * covers them turns the decision into a guess.
 */
function ApprovalView({ approval }: { approval: Approval }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = approval.status === "pending";

  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      // The row is the source of truth, so nothing is set locally; the run's
      // own `tool.approval.resolved` event repaints this card.
      await api.decideApproval(approval.id, approved);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  const entries = Object.entries(approval.detail ?? {}).filter(
    ([key, value]) => DETAIL_LABELS[key] && value !== "" && value !== undefined && value !== null,
  );
  const recoverable = approval.detail?.recoverable === true;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-3",
        pending ? "border-warning/50 bg-warning/8" : "bg-muted/40",
      )}
      data-approval={approval.id}
      data-status={approval.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={pending ? "warning" : "neutral"}>{ACTION_LABELS[approval.action] ?? approval.action}</Badge>
        <span className="text-sm">{approval.summary}</span>
      </div>

      {entries.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-muted-foreground">{DETAIL_LABELS[key]}</dt>
              {/* The command wraps rather than clipping: this card is the only
                  thing standing between the model and an arbitrary shell, and a
                  reader cannot approve what the column cut off. */}
              <dd className={cn("min-w-0 font-mono", key === "command" ? "whitespace-pre-wrap break-all" : "truncate")}>
                {key === "bytes" || key === "currentBytes" || key === "newBytes"
                  ? formatBytes(Number(value))
                  : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {pending ? (
        <div className="flex items-center gap-2">
          <span className="mr-auto text-xs text-muted-foreground">
            {recoverable ? "可通过 restore_file 恢复" : "无法自动恢复"}
          </span>
          <Button size="sm" disabled={busy} onClick={() => void decide(false)}>
            拒绝
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide(true)}>
            批准执行
          </Button>
        </div>
      ) : (
        <span className={cn("text-xs", approval.status === "approved" ? "text-success" : "text-muted-foreground")}>
          {approval.status === "approved"
            ? "已批准"
            : approval.status === "expired"
              ? "已超时，未执行"
              : "已拒绝，未执行"}
        </span>
      )}
    </div>
  );
}

const ToolView = memo(function ToolView({ part }: { part: Extract<Turn["parts"][number], { kind: "tool" }> }) {
  const args = (part.args ?? {}) as Record<string, unknown>;
  // `intent` is what the model said it was doing; the fallbacks are for tools
  // called before that convention, and for MCP tools that never had it.
  const summary =
    typeof args.intent === "string"
      ? args.intent
      : typeof args.query === "string"
        ? args.query
        : typeof args.prompt === "string"
          ? String(args.prompt).slice(0, 90)
          : "";

  return (
    <details className="group/tool rounded-lg border bg-muted/30 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-180" />
        <span className="shrink-0 font-mono text-xs">{part.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        {part.running ? (
          <Spinner className="text-muted-foreground" />
        ) : (
          <Badge tone={part.isError ? "danger" : "success"}>{part.isError ? "失败" : "完成"}</Badge>
        )}
      </summary>
      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <pre className="overflow-x-auto text-xs text-muted-foreground">{JSON.stringify(part.args, null, 2)}</pre>
        {part.result ? <pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap">{part.result}</pre> : null}
      </div>
    </details>
  );
});

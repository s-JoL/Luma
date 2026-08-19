import { useEffect, useState } from "react";
import type { ModelSpec, PromptDefaults, PromptSettings } from "@shared/types.ts";
import { isChatKind } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Button,
  Empty,
  Field,
  Section,
  SectionBody,
  Select,
  Switch,
  Textarea,
  useAction,
  useToast,
} from "../../ui.tsx";

export function PromptsSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [prompts, setPrompts] = useState<PromptSettings | null>(null);
  const [defaults, setDefaults] = useState<PromptDefaults | null>(null);
  const [models, setModels] = useState<ModelSpec[]>([]);

  useEffect(() => {
    Promise.all([api.prompts(), api.promptDefaults(), api.models()])
      .then(([promptSettings, promptDefaults, modelList]) => {
        setPrompts(promptSettings);
        setDefaults(promptDefaults);
        setModels(modelList.items);
      })
      .catch((error: unknown) => toast(String(error), true));
  }, [toast]);

  if (!prompts) return <Empty>正在加载…</Empty>;

  /**
   * Putting a field back to what ships. A prompt that has been edited is
   * otherwise a one-way door: the recommended pair improves with the app, and an
   * install that saved its own copy would never see any of it.
   */
  const restore = (key: keyof PromptDefaults) => {
    if (!defaults || prompts[key] === defaults[key]) return null;
    return (
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => setPrompts({ ...prompts, [key]: defaults[key] })}>
          恢复默认
        </Button>
      </div>
    );
  };

  return (
    <>
      <Section title="系统提示" hint="全局提示在前，工具提示在后。预设可以逐个覆盖这两段。">
        <SectionBody>
          <Field label="全局提示">
            <Textarea
              rows={12}
              value={prompts.globalPrompt}
              onChange={(event) => setPrompts({ ...prompts, globalPrompt: event.target.value })}
            />
            {restore("globalPrompt")}
          </Field>
          <Field label={`工具提示（支持 ${"{{model_name}}"} 与 ${"{{provider_name}}"} 占位符）`}>
            <Textarea
              rows={18}
              value={prompts.toolPrompt}
              onChange={(event) => setPrompts({ ...prompts, toolPrompt: event.target.value })}
            />
            {restore("toolPrompt")}
          </Field>
        </SectionBody>
      </Section>

      <Section title="标题生成">
        <SectionBody>
          <Switch
            label="首轮结束后自动命名对话"
            checked={prompts.titleEnabled}
            onChange={(value) => setPrompts({ ...prompts, titleEnabled: value })}
          />
          <Field label="命名使用的模型" hint="小而快的模型足够，也省下主模型的上下文">
            <Select
              value={prompts.titleModelId}
              options={[
                { value: "", label: "跟随当前对话模型" },
                ...models
                  .filter((model) => model.enabled && isChatKind(model.kind))
                  .map((model) => ({ value: model.id, label: model.name, hint: model.providerId })),
              ]}
              onChange={(value) => setPrompts({ ...prompts, titleModelId: value })}
            />
          </Field>
        </SectionBody>
      </Section>

      <div>
        <Button
          variant="primary"
          onClick={() =>
            void act(async () => {
              setPrompts(await api.savePrompts(prompts));
              await reload();
            }, "提示词已保存")
          }
        >
          保存全部
        </Button>
      </div>
    </>
  );
}

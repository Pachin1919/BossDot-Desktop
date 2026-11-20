import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { hasUnexportableTailorContent, type TailorResult } from './jobAssistant';

export interface TailorCheckpointStore {
  read(runId: string): Promise<string | null>;
  write(runId: string, snapshot: string): Promise<void>;
}

type StoredCheckpoint = Pick<MemorySaver, 'storage' | 'writes'>;

class LocalTailorSaver extends MemorySaver {
  private flushed: Promise<void> = Promise.resolve();

  constructor(private readonly runId: string, private readonly store: TailorCheckpointStore) {
    super();
  }

  async restore() {
    const snapshot = await this.store.read(this.runId);
    if (!snapshot) return;
    const data: StoredCheckpoint = JSON.parse(snapshot, (_key, value) =>
      Array.isArray(value?.resumeCheckpointBytes) ? Uint8Array.from(value.resumeCheckpointBytes) : value
    );
    this.storage = data.storage;
    this.writes = data.writes;
  }

  private persist() {
    const snapshot = JSON.stringify({ storage: this.storage, writes: this.writes }, (_key, value) =>
      value instanceof Uint8Array ? { resumeCheckpointBytes: Array.from(value) } : value
    );
    this.flushed = this.flushed.then(() => this.store.write(this.runId, snapshot));
    return this.flushed;
  }

  override async put(...args: Parameters<MemorySaver['put']>) {
    const config = await super.put(...args);
    await this.persist();
    return config;
  }

  override async putWrites(...args: Parameters<MemorySaver['putWrites']>) {
    await super.putWrites(...args);
    await this.persist();
  }
}

const TailorState = Annotation.Root({
  result: Annotation<TailorResult | null>(),
  status: Annotation<'generating' | 'ready' | 'preview'>(),
});

export async function tailorRunId(input: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return 'resume-' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function runTailorWorkflow(
  store: TailorCheckpointStore,
  runId: string,
  generate: () => Promise<TailorResult>,
  restoreOnly = false,
) {
  let saver = new LocalTailorSaver(runId, store);
  await saver.restore();
  const compile = (checkpointer: LocalTailorSaver) => new StateGraph(TailorState)
    .addNode('generate', async () => ({ result: await generate() }))
    .addNode('verify', ({ result }) => ({
      status: result && !hasUnexportableTailorContent(result) ? 'ready' as const : 'preview' as const,
    }))
    .addEdge(START, 'generate')
    .addEdge('generate', 'verify')
    .addEdge('verify', END)
    .compile({ checkpointer });
  let graph = compile(saver);
  const config = { configurable: { thread_id: runId }, durability: 'sync' as const };
  const state = await graph.getState(config);
  if (restoreOnly) return state.next.length ? null : state.values.result ?? null;
  const resuming = state.next.length > 0;
  if (!resuming && state.values.result) {
    saver = new LocalTailorSaver(runId, store);
    graph = compile(saver);
  }
  const output = await graph.invoke(resuming ? null : { result: null, status: 'generating' }, config);
  if (!output.result) throw new Error('定制简历流程没有返回结果');
  return output.result;
}

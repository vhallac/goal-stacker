import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STORE_DIR = path.join(process.cwd(), ".goal-stacker");
const STORE_FILE = path.join(STORE_DIR, "store.jsonl");

interface StoreLine {
  ts: string;
  sessionId: string | undefined;
  kind: "rootGoal";
  rootGoal: string;
}

function readStore(): StoreLine[] {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StoreLine);
  } catch {
    return []; // 4.a.1: empty or unreadable -> inject nothing
  }
}

export default function goalStackerSpike(pi: ExtensionAPI) {
  const log = (line: string) => console.error(`[goal-stacker:spike] ${line}`);

  pi.on("session_start", async (event, ctx) => {
    log(
      `session_start reason=${event.reason} previousSessionFile=${(event as { previousSessionFile?: string }).previousSessionFile ?? "none"} session=${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`,
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt;
    const sessionId = ctx.sessionManager.getSessionId?.() ?? undefined;

    if (!fs.existsSync(STORE_FILE)) {
      fs.mkdirSync(STORE_DIR, { recursive: true }); // 2.a.1: create store if absent
      log("store created (was absent)");
    }
    const prior = readStore();
    if (prior.length === 0) {
      // Round 1: record the verbatim prompt as rootGoal
      const line: StoreLine = {
        ts: new Date().toISOString(),
        sessionId,
        kind: "rootGoal",
        rootGoal: prompt,
      };
      fs.appendFileSync(STORE_FILE, JSON.stringify(line) + "\n");
      log(`rootGoal recorded: ${prompt.slice(0, 80)}`);
      return; // round 1: no injection yet
    }

    // Round 2+: render state view and inject
    const stateView = [
      "[goal-stacker spike] stored state from previous rounds of this session:",
      ...prior.map((l) => `- rootGoal: ${l.rootGoal}`),
    ].join("\n");
    log("injecting state view");
    return {
      message: {
        customType: "goal-stacker-spike",
        content: stateView,
        display: true,
      },
    };
  });

  pi.on("session_shutdown", async (event) => {
    log(`session_shutdown reason=${(event as { reason?: string }).reason ?? "n/a"}`);
  });
}

import { expect, test } from "bun:test";
import { createModule } from "./index.ts";
import { createStatusPhotoLedger } from "./status-photo-ledger.ts";

const photo = { name: "原照片.jpg", sha256: "b".repeat(64) };
const group = { message_type: "group", self_id: 99, user_id: 51, group_id: 77, runtimeStatusScope: "onebot" } as const;

test("只在确认送达后保存命令和状态卡，两小时内按协议、机器人、会话与引用隔离", async () => {
  const persisted = new Map<string, string>();
  let clock = Date.now();
  const store = {
    async get(key: string) { return persisted.get(key); },
    async set(key: string, value: string, ttl: number) {
      expect(ttl).toBe(7_200);
      persisted.set(key, value);
    },
  };
  const photos = createStatusPhotoLedger(store, undefined, () => clock);
  expect(await photos.find(group, "-33")).toBeUndefined();
  await photos.delivered({ ...group, runtimeStatusScope: undefined }, 31, -33, photo);
  expect(persisted.size).toBe(0);
  await photos.delivered(group, 31, -33, photo);
  expect(persisted.size).toBe(2);
  for (const context of [
    { ...group, self_id: 100 }, { ...group, group_id: 78 }, { ...group, adapter: "milky" as const },
    { ...group, isDelegated: true }, { ...group, message_type: "private" as const },
  ]) expect(await photos.find(context, -33)).toBeUndefined();

  const restarted = createStatusPhotoLedger(store, undefined, () => clock);
  expect(await restarted.find({ ...group, user_id: 52 }, "-33")).toMatchObject({ photo, authoredBy: 99, card: true });
  expect(await restarted.find({ ...group, user_id: 52 }, 31)).toMatchObject({ photo, authoredBy: 51, card: false });
  expect(await restarted.find(group)).toBeUndefined();
  clock += 7_200_000;
  expect(await restarted.find(group, -33)).toBeUndefined();
});

test("Milky 序列 0 可用于原图，私聊同用户之外读不到", async () => {
  const photos = createStatusPhotoLedger();
  const reply = { ...group, runtimeStatusScope: "milky", adapter: "milky", message_type: "private" } as const;
  await photos.delivered(reply, 8, 0, photo);
  expect(await photos.find(reply, "0")).toMatchObject({ authoredBy: 99, card: true });
  expect(await photos.find({ ...reply, user_id: 52 }, 0)).toBeUndefined();
  expect(await photos.find({ ...reply, adapter: undefined }, 8)).toBeUndefined();
});

test("裸命令或不在状态卡记录中的引用会旁路，不请求网关历史", async () => {
  const { fallback } = createModule({});
  let lookups = 0;
  const context = { ...group, isMaster: false, async lookupReply() {
    lookups++;
    return { user_id: 99, message: [{ type: "image" }] };
  } };
  expect(await fallback("#原图", context)).toBeUndefined();
  expect(await fallback("原图", { ...context, reply_id: 1 })).toBeUndefined();
  expect(lookups).toBe(0);
});

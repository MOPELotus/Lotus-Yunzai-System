import { isStatusPhoto, type StatusPhoto } from "./status-background.ts";

export interface StatusPhotoStorage {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

interface PhotoContext {
  readonly adapter?: "milky";
  readonly runtimeStatusScope?: "onebot" | "milky" | "terminal";
  readonly message_type: "terminal" | "private" | "group";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly isDelegated?: boolean;
  readonly privateCredentialSignal?: AbortSignal;
}

interface PhotoRecord {
  readonly photo: StatusPhoto;
  readonly authoredBy: number;
  readonly card: boolean;
  readonly expiresAt: number;
}

const lifetime = 2 * 60 * 60;
const capacity = 4_096;

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function scope(context: PhotoContext) {
  const { message_type: chat, self_id: bot, user_id: user, group_id: group } = context;
  if (context.isDelegated || context.privateCredentialSignal?.aborted ||
      chat === "terminal" || !positive(bot) || !positive(user)) return;
  const peer = chat === "group" ? group : user;
  if (!positive(peer)) return;
  const adapter: "onebot" | "milky" = context.adapter ?? "onebot";
  return { adapter, bot, user, address: `${adapter}:${bot}:${chat}:${peer}` };
}

function messageNumber(value: string | number | undefined, adapter: "onebot" | "milky") {
  const id = typeof value === "string" && /^-?(?:0|[1-9]\d{0,15})$/u.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
  if (adapter === "milky" ? id >= 0 : id !== 0 && id >= -2_147_483_648 && id <= 2_147_483_647) return id;
}

function decode(value: string | null | undefined, now: number): PhotoRecord | undefined {
  if (!value || value.length > 2048) return;
  try {
    const record = JSON.parse(value) as Partial<PhotoRecord> | null;
    if (isStatusPhoto(record?.photo) && positive(record.authoredBy) && typeof record.card === "boolean" &&
        positive(record.expiresAt) && record.expiresAt > now && record.expiresAt <= now + lifetime * 1_000) {
      return { photo: record.photo, authoredBy: record.authoredBy, card: record.card, expiresAt: record.expiresAt };
    }
  } catch {
    return;
  }
}

export function createStatusPhotoLedger(storage?: StatusPhotoStorage, signal?: AbortSignal, now = Date.now) {
  const recent = new Map<string, PhotoRecord>();
  function remember(key: string, record: PhotoRecord) {
    recent.delete(key);
    recent.set(key, record);
    if (recent.size > capacity) {
      const first = recent.keys().next().value;
      if (first !== undefined) recent.delete(first);
    }
  }

  async function save(key: string, record: PhotoRecord) {
    remember(key, record);
    try {
      await storage?.set(key, JSON.stringify(record), lifetime);
    } catch {
      // Local receipts still work when the optional persistent storage is unavailable.
    }
  }

  return {
    async delivered(context: PhotoContext, original: number | undefined, confirmed: number, photo: StatusPhoto) {
      const room = scope(context);
      if (signal?.aborted || !room || context.runtimeStatusScope !== room.adapter || !isStatusPhoto(photo)) return;
      const sent = messageNumber(confirmed, room.adapter);
      if (sent === undefined) return;
      const received = messageNumber(original, room.adapter);
      const expiresAt = now() + lifetime * 1_000;
      await Promise.all([
        save(`${room.address}:${sent}`, { photo, authoredBy: room.bot, card: true, expiresAt }),
        received !== undefined && received !== sent
          ? save(`${room.address}:${received}`, { photo, authoredBy: room.user, card: false, expiresAt }) : undefined,
      ]);
    },
    async find(context: PhotoContext, reference?: string | number) {
      const room = scope(context);
      if (signal?.aborted || !room || context.runtimeStatusScope !== room.adapter) return;
      const id = messageNumber(reference, room.adapter);
      if (id === undefined) return;
      const key = `${room.address}:${id}`;
      const local = recent.get(key);
      if (local && local.expiresAt > now()) return local;
      recent.delete(key);
      try {
        const remote = decode(await storage?.get(key), now());
        if (remote && !signal?.aborted && !context.privateCredentialSignal?.aborted) {
          remember(key, remote);
          return remote;
        }
      } catch {
        return;
      }
    },
  };
}

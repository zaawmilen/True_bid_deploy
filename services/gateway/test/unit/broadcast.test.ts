import { beforeEach, describe, expect, it, vi } from "vitest";
import { addConnection, broadcast, connections, removeConnection } from "../../src/index.js";

function fakeSocket(readyState = 1 /* OPEN */) {
  return { readyState, OPEN: 1, send: vi.fn() } as unknown as import("ws").WebSocket;
}

describe("connection registry", () => {
  beforeEach(() => {
    connections.clear();
  });

  it("creates a lot entry on first connection and tracks multiple sockets", () => {
    const ws1 = fakeSocket();
    const ws2 = fakeSocket();
    addConnection("LOT-1", ws1);
    addConnection("LOT-1", ws2);
    expect(connections.get("LOT-1")?.size).toBe(2);
  });

  it("keeps different lots' connections isolated from each other", () => {
    addConnection("LOT-1", fakeSocket());
    addConnection("LOT-2", fakeSocket());
    expect(connections.get("LOT-1")?.size).toBe(1);
    expect(connections.get("LOT-2")?.size).toBe(1);
  });

  it("removes a socket from its lot without affecting other sockets on that lot", () => {
    const ws1 = fakeSocket();
    const ws2 = fakeSocket();
    addConnection("LOT-1", ws1);
    addConnection("LOT-1", ws2);
    removeConnection("LOT-1", ws1);
    expect(connections.get("LOT-1")?.has(ws1)).toBe(false);
    expect(connections.get("LOT-1")?.has(ws2)).toBe(true);
  });

  it("is a no-op to remove from a lot that was never connected", () => {
    expect(() => removeConnection("LOT-NEVER-SEEN", fakeSocket())).not.toThrow();
  });
});

describe("broadcast", () => {
  beforeEach(() => {
    connections.clear();
  });

  it("sends the envelope to every open socket subscribed to that lot", async () => {
    const ws1 = fakeSocket();
    const ws2 = fakeSocket();
    addConnection("LOT-1", ws1);
    addConnection("LOT-1", ws2);

    await broadcast("LOT-1", { type: "cost_update", data: { lot_id: "LOT-1", total: 1000 } });

    const expectedPayload = JSON.stringify({ type: "cost_update", data: { lot_id: "LOT-1", total: 1000 } });
    expect((ws1.send as any)).toHaveBeenCalledWith(expectedPayload);
    expect((ws2.send as any)).toHaveBeenCalledWith(expectedPayload);
  });

  it("does not send to sockets that are not OPEN (e.g. still connecting or closing)", async () => {
    const connecting = fakeSocket(0); // CONNECTING
    addConnection("LOT-1", connecting);

    await broadcast("LOT-1", { type: "anomaly_score", data: { lot_id: "LOT-1" } });

    expect((connecting.send as any)).not.toHaveBeenCalled();
  });

  it("silently no-ops when broadcasting to a lot with no connected sockets", async () => {
    await expect(
      broadcast("LOT-NOBODY-WATCHING", { type: "cost_update", data: {} })
    ).resolves.not.toThrow();
  });

  it("does not leak a broadcast for one lot to sockets watching a different lot", async () => {
    const watchingLot1 = fakeSocket();
    const watchingLot2 = fakeSocket();
    addConnection("LOT-1", watchingLot1);
    addConnection("LOT-2", watchingLot2);

    await broadcast("LOT-1", { type: "cost_update", data: { lot_id: "LOT-1" } });

    expect((watchingLot1.send as any)).toHaveBeenCalledTimes(1);
    expect((watchingLot2.send as any)).not.toHaveBeenCalled();
  });
});

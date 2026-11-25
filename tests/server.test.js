const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const { createGameServer, getCrossingTimeMs, getFinishTiming, isFinishCrossing } = require("../server");

let game;
let baseUrl;

function connect(client) {
  if (client.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
}

function waitForRaceState(client, predicate, timeoutMs = 3000) {
  let latestState;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("raceState", onState);
      reject(new Error(`Timed out waiting for a race state: ${JSON.stringify(latestState?.cars)}`));
    }, timeoutMs);
    function onState(state) {
      latestState = state;
      if (!predicate(state)) return;
      clearTimeout(timeout);
      client.off("raceState", onState);
      resolve(state);
    }
    client.on("raceState", onState);
  });
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

beforeEach(async () => {
  game = createGameServer();
  await new Promise((resolve) => game.httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${game.httpServer.address().port}`;
});

afterEach(async () => {
  await game.close();
});

test("reports the winner's elapsed time and the other finishers' gaps", () => {
  const timing = getFinishTiming([
    { id: "second", finishedAt: 3450 },
    { id: "winner", finishedAt: 2780 },
    { id: "still-racing", finishedAt: null },
  ], 1000);

  assert.deepEqual(timing.get("winner"), {
    isFirstFinisher: true,
    finishTimeMs: 1780,
    gapMs: 0,
  });
  assert.deepEqual(timing.get("second"), {
    isFirstFinisher: false,
    finishTimeMs: 2450,
    gapMs: 670,
  });
  assert.equal(timing.has("still-racing"), false);
});

test("keeps finish times distinct when racers cross during the same server tick", () => {
  const finishProgress = 6.28;
  const tickEndTime = 5000;
  const tickDuration = 0.05;
  const firstCrossing = getCrossingTimeMs(6, 6.32, finishProgress, tickEndTime, tickDuration);
  const earlierCrossing = getCrossingTimeMs(6.1, 6.33, finishProgress, tickEndTime, tickDuration);

  assert.ok(earlierCrossing < firstCrossing);
  assert.ok(firstCrossing < tickEndTime);
});

test("requires crossing the start line after completing the race distance", () => {
  const startAngle = -Math.PI / 2;
  const finishProgress = Math.PI * 2 * 3 + 0.2;
  const completedProgress = finishProgress + 0.01;

  assert.equal(isFinishCrossing(
    completedProgress,
    finishProgress,
    startAngle - 0.02,
    startAngle - 0.01
  ), false);
  assert.equal(isFinishCrossing(
    completedProgress,
    finishProgress,
    startAngle - 0.01,
    startAngle + 0.01
  ), true);
  assert.equal(isFinishCrossing(
    completedProgress,
    finishProgress,
    startAngle + 0.01,
    startAngle - 0.01
  ), false);
});

test("serves the game, Three.js locally, and health status", async () => {
  const [page, three, health] = await Promise.all([
    fetch(baseUrl),
    fetch(`${baseUrl}/vendor/three.module.js`),
    fetch(`${baseUrl}/healthz`),
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Race2Win/);
  assert.equal(three.status, 200);
  assert.match(await three.text(), /THREE/);
  assert.deepEqual(await health.json(), { ok: true });
});

test("lets a driver join with bots and start a shared race", async () => {
  const client = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  try {
    await connect(client);
    const initialState = waitForRaceState(client, (state) => state.cars.length === 3);
    const joined = await new Promise((resolve) => {
      client.emit("joinRace", { name: "Prueba", botCount: 2 }, resolve);
    });
    assert.equal(joined.ok, true);

    const state = await initialState;
    assert.equal(state.hostId, joined.id);
    assert.equal(state.cars.filter((car) => car.isBot).length, 2);
    assert.equal(state.raceElapsedMs, 0);
    const driverState = state.cars.find((car) => car.id === joined.id);
    assert.equal(driverState.place, 1);
    assert.equal(driverState.isFirstFinisher, false);
    assert.equal(driverState.finishTimeMs, null);

    const countdownState = waitForRaceState(client, (nextState) => nextState.phase === "countdown");
    client.emit("startRace");
    assert.equal((await countdownState).phase, "countdown");

    const racingState = waitForRaceState(client, (nextState) => nextState.phase === "racing", 5000);
    const racing = await racingState;
    assert.ok(Number.isFinite(racing.raceElapsedMs));
    const movingState = waitForRaceState(client, (nextState) => {
      const driver = nextState.cars.find((car) => car.id === joined.id);
      const bots = nextState.cars.filter((car) => car.isBot);
      return driver?.speed > 1 && bots.every((bot) => bot.progress > 0.02);
    });
    client.emit("driverInput", { throttle: 1, brake: 0, steer: 1 });
    const moving = await movingState;
    const movingDriver = moving.cars.find((car) => car.id === joined.id);
    assert.ok(movingDriver.speed > 1);
    assert.ok(wrapAngle(movingDriver.yaw - driverState.yaw) < 0);
    assert.ok(moving.cars.filter((car) => car.isBot).every((bot) => bot.progress > 0.02));

    const countersteeringState = waitForRaceState(client, (nextState) => {
      const driver = nextState.cars.find((car) => car.id === joined.id);
      return driver && wrapAngle(driver.yaw - movingDriver.yaw) > 0;
    }, 2000);
    client.emit("driverInput", { throttle: 1, brake: 0, steer: -1 });
    const countersteering = await countersteeringState;
    assert.ok(wrapAngle(countersteering.cars.find((car) => car.id === joined.id).yaw - movingDriver.yaw) > 0);
  } finally {
    client.disconnect();
  }
});

test("shares a LAN lobby and resets it after the last human leaves", { timeout: 7000 }, async () => {
  const host = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  const guest = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  const nextDriver = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  try {
    await connect(host);
    const hostJoin = await new Promise((resolve) => {
      host.emit("joinRace", { name: "Anfitrión", botCount: 1 }, resolve);
    });
    assert.equal(hostJoin.ok, true);

    await connect(guest);
    const guestState = waitForRaceState(guest, (state) => state.cars.length === 3);
    const guestJoin = await new Promise((resolve) => {
      guest.emit("joinRace", { name: "Invitado", botCount: 7 }, resolve);
    });
    assert.equal(guestJoin.ok, true);
    assert.equal((await guestState).cars.filter((car) => !car.isBot).length, 2);

    const hostTransfer = waitForRaceState(guest, (state) => state.hostId === guestJoin.id);
    host.disconnect();
    assert.equal((await hostTransfer).hostId, guestJoin.id);

    guest.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await connect(nextDriver);
    const nextJoin = await new Promise((resolve) => {
      nextDriver.emit("joinRace", { name: "Siguiente", botCount: 0 }, resolve);
    });
    assert.equal(nextJoin.ok, true);
  } finally {
    host.disconnect();
    guest.disconnect();
    nextDriver.disconnect();
  }
});

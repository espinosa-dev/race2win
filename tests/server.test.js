const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const tracks = require("../public/tracks.json");
const {
  areHumanDriversFinished,
  constrainCarToMap,
  constrainCarToTrack,
  createGameServer,
  getCrossingTimeMs,
  getFinishTiming,
  resolveCarCollisions,
} = require("../server");

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

function segmentsIntersect(a, b, c, d) {
  const orientation = (first, second, point) => (
    (second[0] - first[0]) * (point[1] - first[1])
    - (second[1] - first[1]) * (point[0] - first[0])
  );
  const onSegment = (first, second, point) => (
    point[0] >= Math.min(first[0], second[0])
    && point[0] <= Math.max(first[0], second[0])
    && point[1] >= Math.min(first[1], second[1])
    && point[1] <= Math.max(first[1], second[1])
  );
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (first * second < 0 && third * fourth < 0) return true;
  return (first === 0 && onSegment(a, b, c))
    || (second === 0 && onSegment(a, b, d))
    || (third === 0 && onSegment(c, d, a))
    || (fourth === 0 && onSegment(c, d, b));
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

test("keeps cars inside map bounds and stops them at the edge", () => {
  const car = { x: 70, z: -80, speed: 12 };
  assert.equal(constrainCarToMap(car, { bounds: 65 }), false);
  assert.deepEqual(car, { x: 65, z: -65, speed: 0 });
  assert.equal(constrainCarToMap(car, { bounds: 65 }), true);
});

test("keeps circuit centerlines free of crossing and overlapping sections", () => {
  for (const track of Object.values(tracks)) {
    const points = track.points;
    for (let first = 0; first < points.length; first += 1) {
      for (let second = first + 2; second < points.length; second += 1) {
        if (first === 0 && second === points.length - 1) continue;
        assert.equal(
          segmentsIntersect(
            points[first],
            points[(first + 1) % points.length],
            points[second],
            points[(second + 1) % points.length]
          ),
          false,
          `${track.name} has intersecting segments ${first} and ${second}`
        );
      }
    }
  }
});

test("keeps a car inside the track barriers and slows it on impact", () => {
  const track = {
    width: 10,
    segments: [{ x: 0, z: 0, dx: 20, dz: 0, length: 20, start: 0 }],
    length: 20,
  };
  const car = { x: 5, z: 8, speed: 10 };
  const projection = constrainCarToTrack(car, track);

  assert.equal(car.x, 5);
  assert.ok(Math.abs(car.z) <= 3.88);
  assert.equal(car.speed, 3.5);
  assert.equal(projection.distanceSquared, 64);
});

test("separates colliding cars and transfers some of their speed", () => {
  const cars = [
    { id: "moving", x: 0, z: 0, yaw: -Math.PI / 2, speed: 10, finishedAt: null },
    { id: "stopped", x: 2, z: 0, yaw: -Math.PI / 2, speed: 0, finishedAt: null },
  ];
  resolveCarCollisions(cars);

  assert.ok(Math.hypot(cars[1].x - cars[0].x, cars[1].z - cars[0].z) >= 3.2);
  assert.ok(cars[0].speed < 10);
  assert.ok(cars[1].speed > 0);
});

test("ends a race when all humans finish without waiting for bots", () => {
  assert.equal(areHumanDriversFinished([
    { isBot: false, finishedAt: 3000 },
    { isBot: true, finishedAt: null },
  ]), true);
  assert.equal(areHumanDriversFinished([
    { isBot: false, finishedAt: null },
    { isBot: true, finishedAt: 3000 },
  ]), false);
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
  const tracks = await fetch(`${baseUrl}/tracks.json`);
  assert.equal(tracks.status, 200);
  assert.deepEqual(Object.keys(await tracks.json()).sort(), ["monaco", "monza"]);
});

test("lets a driver join with bots and start a shared race", async () => {
  const client = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  try {
    await connect(client);
    const initialState = waitForRaceState(client, (state) => state.cars.length === 3);
    const joined = await new Promise((resolve) => {
      client.emit("joinRace", { name: "Prueba", maxPlayers: 3, botsEnabled: true, trackId: "monaco" }, resolve);
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

test("lets a driver reverse by holding the brake from a stop", { timeout: 7000 }, async () => {
  const client = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  try {
    await connect(client);
    const initialState = waitForRaceState(client, (state) => state.cars.length === 1);
    const joined = await new Promise((resolve) => {
      client.emit("joinRace", { name: "Reversa", maxPlayers: 1, botsEnabled: false, trackId: "monaco" }, resolve);
    });
    assert.equal(joined.ok, true);
    const initial = await initialState;
    const initialCar = initial.cars.find((car) => car.id === joined.id);

    const racingState = waitForRaceState(client, (state) => state.phase === "racing", 5000);
    client.emit("startRace");
    await racingState;

    const reversingState = waitForRaceState(client, (state) => {
      const driver = state.cars.find((car) => car.id === joined.id);
      return driver?.speed < -0.5
        && Math.hypot(driver.x - initialCar.x, driver.z - initialCar.z) > 0.1;
    }, 2000);
    client.emit("driverInput", { throttle: 0, brake: 1, steer: 0 });
    const reversing = await reversingState;
    const reversingCar = reversing.cars.find((car) => car.id === joined.id);
    assert.ok(reversingCar.speed < 0);
    assert.ok(Math.hypot(reversingCar.x - initialCar.x, reversingCar.z - initialCar.z) > 0.1);
  } finally {
    client.disconnect();
  }
});

test("replaces lobby bots with joining people and resets after the last human leaves", { timeout: 7000 }, async () => {
  const host = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  const guest = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  const nextDriver = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  const overflow = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
  try {
    await connect(host);
    const hostJoin = await new Promise((resolve) => {
      host.emit("joinRace", { name: "Anfitrión", maxPlayers: 2, botsEnabled: true, trackId: "monza" }, resolve);
    });
    assert.equal(hostJoin.ok, true);

    await connect(guest);
    const guestState = waitForRaceState(
      guest,
      (state) => state.cars.length === 2 && state.cars.filter((car) => !car.isBot).length === 2
    );
    const guestJoin = await new Promise((resolve) => {
      guest.emit("joinRace", { name: "Invitado", maxPlayers: 8, botsEnabled: false, trackId: "monaco" }, resolve);
    });
    assert.equal(guestJoin.ok, true);
    const joinedState = await guestState;
    assert.equal(joinedState.cars.filter((car) => !car.isBot).length, 2);
    assert.equal(joinedState.cars.filter((car) => car.isBot).length, 0);
    assert.equal(joinedState.track.id, "monza");

    await connect(overflow);
    const rejected = await new Promise((resolve) => {
      overflow.emit("joinRace", { name: "Exceso", maxPlayers: 8, botsEnabled: true }, resolve);
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /completa/);

    const hostTransfer = waitForRaceState(guest, (state) => state.hostId === guestJoin.id);
    host.disconnect();
    assert.equal((await hostTransfer).hostId, guestJoin.id);

    guest.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await connect(nextDriver);
    const nextJoin = await new Promise((resolve) => {
      nextDriver.emit("joinRace", { name: "Siguiente", maxPlayers: 1, botsEnabled: false, trackId: "monaco" }, resolve);
    });
    assert.equal(nextJoin.ok, true);
  } finally {
    host.disconnect();
    guest.disconnect();
    nextDriver.disconnect();
    overflow.disconnect();
  }
});

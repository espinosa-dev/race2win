const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const tracks = require("../public/tracks.json");
const catalog = require("../public/catalog.json");
const { getTrackEdges } = require("../public/track-geometry");
const {
  areHumanDriversFinished,
  calculateRaceRewards,
  constrainCarToMap,
  constrainCarToTrack,
  createGameServer,
  getCrossingTimeMs,
  getFinishTiming,
  resolveCarCollisions,
  settleRaceOnce,
} = require("../server");

let game;
let baseUrl;
let dataDir;

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

async function requestJson(endpoint, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    response,
    data: response.status === 204 ? null : await response.json(),
  };
}

async function createTestAccount(username = "PilotTest", password = "RacingPass123") {
  const { response, data } = await requestJson("/api/register", {
    method: "POST",
    body: { username, password },
  });
  assert.equal(response.status, 201);
  return data;
}

function getTrackOffset(track, car) {
  const edges = getTrackEdges(track);
  let nearest = null;
  for (let index = 0; index < track.points.length; index += 1) {
    const start = track.points[index];
    const end = track.points[(index + 1) % track.points.length];
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const fraction = Math.max(0, Math.min(1, ((car.x - start[0]) * dx + (car.z - start[1]) * dz) / (dx * dx + dz * dz)));
    const distance = Math.hypot(car.x - start[0] - dx * fraction, car.z - start[1] - dz * fraction);
    if (!nearest || distance < nearest.distance) {
      nearest = {
        distance,
        width: edges[index].width + (edges[(index + 1) % edges.length].width - edges[index].width) * fraction,
      };
    }
  }
  return nearest;
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "race2win-test-"));
  game = createGameServer({ dataDir });
  await new Promise((resolve) => game.httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${game.httpServer.address().port}`;
});

afterEach(async () => {
  await game.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
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

test("calculates competitive rewards with completion and fastest-lap bonuses", () => {
  const solo = calculateRaceRewards({
    place: 1,
    entrantCount: 1,
    lapsCompleted: 3,
    bestLapMs: 90000,
    fastestLapMs: 90000,
  });
  assert.equal(solo.coins, 0);
  assert.equal(solo.points, 0);
  assert.equal(solo.rivals, 0);

  const winner = calculateRaceRewards({
    place: 1,
    entrantCount: 4,
    lapsCompleted: 3,
    bestLapMs: 90000,
    fastestLapMs: 90000,
  });
  assert.equal(winner.points, 160);
  assert.equal(winner.coins, 175);
  assert.equal(winner.completedBonus, true);
  assert.equal(winner.fastestLapBonus, true);

  const second = calculateRaceRewards({
    place: 2,
    entrantCount: 4,
    lapsCompleted: 2,
    bestLapMs: 91000,
    fastestLapMs: 90000,
  });
  assert.equal(second.points, 70);
  assert.equal(second.coins, 85);
  assert.equal(second.completedBonus, false);
  assert.equal(second.fastestLapBonus, false);

  const oneOnOne = calculateRaceRewards({
    place: 1,
    entrantCount: 2,
    lapsCompleted: 0,
  });
  assert.equal(oneOnOne.basePoints, 60);
  assert.equal(oneOnOne.baseCoins, 72);
});

test("settles a race only once even if completion is requested repeatedly", () => {
  const settlement = { rewarded: false };
  let payouts = 0;
  assert.equal(settleRaceOnce(settlement, () => { payouts += 1; }), true);
  assert.equal(settleRaceOnce(settlement, () => { payouts += 1; }), false);
  assert.equal(payouts, 1);
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

test("keeps widened road edges non-intersecting through tight corners", () => {
  for (const track of Object.values(tracks)) {
    const edges = getTrackEdges(track);
    for (const edge of edges) {
      assert.ok(edge.width > 0 && edge.width <= track.width);
    }
    for (const side of ["left", "right"]) {
      for (let first = 0; first < edges.length; first += 1) {
        for (let second = first + 2; second < edges.length; second += 1) {
          if (first === 0 && second === edges.length - 1) continue;
          assert.equal(
            segmentsIntersect(
              edges[first][side],
              edges[(first + 1) % edges.length][side],
              edges[second][side],
              edges[(second + 1) % edges.length][side]
            ),
            false,
            `${track.name} ${side} road edge overlaps at ${first} and ${second}`
          );
        }
      }
      for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
        for (let rightIndex = 0; rightIndex < edges.length; rightIndex += 1) {
          const adjacent = Math.min(
            (rightIndex - leftIndex + edges.length) % edges.length,
            (leftIndex - rightIndex + edges.length) % edges.length
          ) <= 1;
          if (adjacent) continue;
          assert.equal(
            segmentsIntersect(
              edges[leftIndex].left,
              edges[(leftIndex + 1) % edges.length].left,
              edges[rightIndex].right,
              edges[(rightIndex + 1) % edges.length].right
            ),
            false,
            `${track.name} inner and outer borders overlap around ${leftIndex} and ${rightIndex}`
          );
        }
      }
    }
    assert.ok(
      edges.filter((edge) => edge.width >= track.width * 0.8).length >= edges.length * 0.4,
      `${track.name} should preserve most of its requested width`
    );
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
  const html = await page.text();
  assert.match(html, /Race2Win/);
  assert.match(html, /race-minimap/);
  assert.match(html, /store-screen/);
  assert.match(html, /garage-screen/);
  assert.equal(three.status, 200);
  assert.match(await three.text(), /THREE/);
  assert.deepEqual(await health.json(), { ok: true });
  const tracks = await fetch(`${baseUrl}/tracks.json`);
  assert.equal(tracks.status, 200);
  assert.deepEqual(Object.keys(await tracks.json()).sort(), ["monaco", "monza"]);
  const catalogResponse = await fetch(`${baseUrl}/catalog.json`);
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual(await catalogResponse.json(), catalog);
});

test("registers and logs in with hashed passwords and persistent profiles", async () => {
  const created = await createTestAccount();
  assert.equal(created.profile.username, "PilotTest");
  assert.equal(created.profile.coins, 500);
  assert.deepEqual(created.profile.equipped, catalog.defaults);
  assert.equal(created.profile.inventory.length, Object.values(catalog.defaults).length);
  assert.equal("passwordHash" in created.profile, false);
  assert.equal("salt" in created.profile, false);
  assert.ok(created.token.length >= 40);

  const storedContent = fs.readFileSync(path.join(dataDir, "accounts.json"), "utf8");
  const stored = JSON.parse(storedContent)[0];
  assert.notEqual(stored.passwordHash, "RacingPass123");
  assert.ok(stored.passwordHash.length >= 128);
  assert.equal(storedContent.includes("RacingPass123"), false);

  const duplicate = await requestJson("/api/register", {
    method: "POST",
    body: { username: "pilottest", password: "RacingPass123" },
  });
  assert.equal(duplicate.response.status, 409);

  const invalidLogin = await requestJson("/api/login", {
    method: "POST",
    body: { username: "PilotTest", password: "WrongPass123" },
  });
  assert.equal(invalidLogin.response.status, 401);
  assert.equal(invalidLogin.data.error, "Usuario o contraseña incorrectos.");

  await game.close();
  game = createGameServer({ dataDir });
  await new Promise((resolve) => game.httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${game.httpServer.address().port}`;
  const login = await requestJson("/api/login", {
    method: "POST",
    body: { username: "PilotTest", password: "RacingPass123" },
  });
  assert.equal(login.response.status, 200);
  const profile = await requestJson("/api/me", { token: login.data.token });
  assert.equal(profile.data.coins, 500);
  assert.equal("passwordHash" in profile.data, false);

  const logout = await requestJson("/api/logout", { method: "POST", token: login.data.token, body: {} });
  assert.equal(logout.response.status, 204);
  const loggedOut = await requestJson("/api/me", { token: login.data.token });
  assert.equal(loggedOut.response.status, 401);
});

test("keeps an active login session valid after the server restarts", async () => {
  const account = await createTestAccount("SessionPilot");
  const sessionsPath = path.join(dataDir, "sessions.json");
  const storedSessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  assert.equal(JSON.stringify(storedSessions).includes(account.token), false);
  const expiredDigest = "e".repeat(64);
  storedSessions.push([expiredDigest, {
    username: "SessionPilot",
    expiresAt: Date.now() - 1,
  }]);
  fs.writeFileSync(sessionsPath, JSON.stringify(storedSessions));

  await game.close();
  game = createGameServer({ dataDir });
  await new Promise((resolve) => game.httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${game.httpServer.address().port}`;

  const profile = await requestJson("/api/me", { token: account.token });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.data.username, "SessionPilot");
  assert.equal(fs.readFileSync(sessionsPath, "utf8").includes(expiredDigest), false);
});

test("returns a public top-ten leaderboard ordered by points and wins", async () => {
  await game.close();
  const accounts = Array.from({ length: 12 }, (_, index) => ({
    username: `Driver${String(index).padStart(2, "0")}`,
    salt: "test-salt",
    passwordHash: "private-hash",
    coins: 500,
    inventory: [],
    equipped: {},
    stats: {
      racesPlayed: index + 1,
      wins: index === 0 ? 1 : index === 1 ? 2 : 0,
      podiums: index,
      bestLapMs: index ? 90000 + index : null,
      points: index < 2 ? 1000 : 1000 - index * 10,
    },
  }));
  fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify(accounts));
  game = createGameServer({ dataDir });
  await new Promise((resolve) => game.httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${game.httpServer.address().port}`;

  const response = await requestJson("/api/leaderboard");
  assert.equal(response.response.status, 200);
  assert.equal(response.data.length, 10);
  assert.equal(response.data[0].username, "Driver01");
  assert.equal(response.data[1].username, "Driver00");
  assert.deepEqual(Object.keys(response.data[0]).sort(), [
    "bestLapMs",
    "podiums",
    "points",
    "racesPlayed",
    "username",
    "wins",
  ]);
  assert.equal(JSON.stringify(response.data).includes("passwordHash"), false);
  assert.equal(JSON.stringify(response.data).includes("private-hash"), false);
});

test("validates shop prices, purchases, and equipped inventory on the server", async () => {
  const account = await createTestAccount();
  const boughtPaint = await requestJson("/api/shop/buy", {
    method: "POST",
    token: account.token,
    body: { itemId: "color-red", price: 1 },
  });
  assert.equal(boughtPaint.response.status, 200);
  assert.equal(boughtPaint.data.coins, 320);
  assert.ok(boughtPaint.data.inventory.includes("color-red"));

  const boughtPattern = await requestJson("/api/shop/buy", {
    method: "POST",
    token: account.token,
    body: { itemId: "camo-checker" },
  });
  assert.equal(boughtPattern.data.coins, 40);

  const insufficient = await requestJson("/api/shop/buy", {
    method: "POST",
    token: account.token,
    body: { itemId: "trail-neon", price: 0 },
  });
  assert.equal(insufficient.response.status, 400);
  assert.match(insufficient.data.error, /suficientes/);

  const equipped = await requestJson("/api/inventory/equip", {
    method: "POST",
    token: account.token,
    body: { category: "color", itemId: "color-red" },
  });
  assert.equal(equipped.response.status, 200);
  assert.equal(equipped.data.equipped.color, "color-red");

  const notOwned = await requestJson("/api/inventory/equip", {
    method: "POST",
    token: account.token,
    body: { category: "trail", itemId: "trail-neon" },
  });
  assert.equal(notOwned.response.status, 403);
  const duplicatePurchase = await requestJson("/api/shop/buy", {
    method: "POST",
    token: account.token,
    body: { itemId: "color-red" },
  });
  assert.equal(duplicatePurchase.response.status, 409);
  const unauthenticated = await requestJson("/api/shop/buy", {
    method: "POST",
    body: { itemId: "color-red" },
  });
  assert.equal(unauthenticated.response.status, 401);
});

test("synchronizes account cosmetics and varied bot loadouts in race snapshots", async () => {
  const account = await createTestAccount("CosmeticPilot");
  const purchase = await requestJson("/api/shop/buy", {
    method: "POST",
    token: account.token,
    body: { itemId: "color-red" },
  });
  assert.equal(purchase.response.status, 200);
  const equip = await requestJson("/api/inventory/equip", {
    method: "POST",
    token: account.token,
    body: { category: "color", itemId: "color-red" },
  });
  assert.equal(equip.response.status, 200);

  const client = createClient(baseUrl, {
    transports: ["websocket"],
    reconnection: false,
    auth: { token: account.token },
  });
  try {
    await connect(client);
    const statePromise = waitForRaceState(client, (state) => state.cars.length === 4);
    const joined = await new Promise((resolve) => {
      client.emit("joinRace", {
        name: "Nombre falso",
        maxPlayers: 4,
        botsEnabled: true,
        trackId: "monaco",
        token: account.token,
      }, resolve);
    });
    assert.equal(joined.ok, true);
    const state = await statePromise;
    const player = state.cars.find((car) => car.id === joined.id);
    assert.equal(player.name, "CosmeticPilot");
    assert.equal(player.color, "#f04d58");
    assert.equal(player.cosmetics.color, "color-red");
    assert.equal("accountUsername" in player, false);
    assert.ok(state.cars.filter((car) => car.isBot).every((car) => car.cosmetics));
    assert.ok(new Set(state.cars.filter((car) => car.isBot).map((car) => JSON.stringify(car.cosmetics))).size > 1);
  } finally {
    client.disconnect();
  }
});

test("revokes an active race connection when its account logs out", async () => {
  const account = await createTestAccount("LogoutPilot");
  const client = createClient(baseUrl, {
    transports: ["websocket"],
    reconnection: false,
    auth: { token: account.token },
  });
  try {
    await connect(client);
    const joinedState = waitForRaceState(client, (state) => state.cars.length === 1);
    const disconnected = new Promise((resolve) => client.once("disconnect", resolve));
    const joined = await new Promise((resolve) => {
      client.emit("joinRace", {
        name: "LogoutPilot",
        maxPlayers: 1,
        botsEnabled: false,
        token: account.token,
      }, resolve);
    });
    assert.equal(joined.ok, true);
    await joinedState;

    const logout = await requestJson("/api/logout", {
      method: "POST",
      token: account.token,
      body: {},
    });
    assert.equal(logout.response.status, 204);
    await disconnected;
    const profile = await requestJson("/api/me", { token: account.token });
    assert.equal(profile.response.status, 401);
  } finally {
    client.disconnect();
  }
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

test("places all eight starting cars inside the adapted road widths", async () => {
  for (const trackId of ["monaco", "monza"]) {
    const client = createClient(baseUrl, { transports: ["websocket"], reconnection: false });
    try {
      await connect(client);
      const statePromise = waitForRaceState(client, (state) => state.cars.length === 8);
      const joined = await new Promise((resolve) => {
        client.emit("joinRace", {
          name: "Parrilla",
          maxPlayers: 8,
          botsEnabled: true,
          trackId,
        }, resolve);
      });
      assert.equal(joined.ok, true);
      const state = await statePromise;
      assert.equal(state.track.width, trackId === "monaco" ? 11.5 : 14.5);
      for (const car of state.cars) {
        const offset = getTrackOffset(state.track, car);
        assert.ok(offset.distance <= offset.width / 2 - 1.12 + 0.02, `${trackId}: ${car.name} is outside the road`);
        assert.ok(Math.abs(car.x) <= state.track.bounds);
        assert.ok(Math.abs(car.z) <= state.track.bounds);
      }
    } finally {
      client.disconnect();
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
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

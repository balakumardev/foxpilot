import WebSocket from "ws";
import crypto from "node:crypto";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

const rawBase = process.argv[2] || "ws://127.0.0.1:8799";
const wsBase = rawBase.replace(/^http/, "ws");
const httpBase = rawBase.replace(/^ws/, "http");

// Random 32-char base64url room id
const roomId = crypto.randomBytes(24).toString("base64url");
console.log(`Running smoke test against ${rawBase} with room ${roomId}…`);

function connect(url) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  let closeInfo = null;
  const closeWaiters = [];

  // IMPORTANT: attach message listener immediately after new WebSocket(...),
  // before the "open" event, as the first frame can arrive in the same packet as 101.
  ws.on("message", (data) => {
    const raw = data.toString();
    try {
      frames.push(JSON.parse(raw));
    } catch {
      frames.push(raw);
    }
    waiters.splice(0).forEach((w) => w());
  });

  ws.on("close", (code, reason) => {
    closeInfo = { code, reason: reason ? reason.toString() : "" };
    closeWaiters.splice(0).forEach((w) => w(closeInfo));
  });

  const openPromise = new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
  });

  return {
    ws,
    frames,
    async waitForOpen() {
      return openPromise;
    },
    async waitForFrame(pred, timeoutMs = 25000) {
      const deadline = Date.now() + timeoutMs;
      while (!frames.some(pred)) {
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for frame. Got frames: ${JSON.stringify(frames)}`
          );
        }
        await new Promise((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return frames.find(pred);
    },
    async waitForClose(timeoutMs = 25000) {
      if (closeInfo) return closeInfo;
      const deadline = Date.now() + timeoutMs;
      while (!closeInfo) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for socket close");
        }
        await new Promise((resolve) => {
          closeWaiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return closeInfo;
    },
  };
}

async function run() {
  try {
    // a. a client joining an empty room first receives {"t":"host","online":false}
    const client1 = connect(`${wsBase}/v1/rooms/${roomId}/client`);
    await client1.waitForOpen();
    const frameA = await client1.waitForFrame(
      (f) => f && f.t === "host" && f.online === false
    );
    assert(frameA.online === false, "Client did not receive host online: false");
    console.log(
      "PASS: a. client joining empty room receives {t: 'host', online: false}"
    );

    // b. a host joining receives {"t":"open","cid":...} for that waiting client, and the client receives {"t":"host","online":true}
    const host1 = connect(`${wsBase}/v1/rooms/${roomId}/host`);
    await host1.waitForOpen();
    const openFrame = await host1.waitForFrame(
      (f) => f && f.t === "open" && typeof f.cid === "string"
    );
    const cid1 = openFrame.cid;
    const onlineFrame = await client1.waitForFrame(
      (f) => f && f.t === "host" && f.online === true
    );
    assert(onlineFrame.online === true, "Client did not receive host online: true");
    console.log(
      `PASS: b. host received open frame (cid=${cid1}) and client received {t: 'host', online: true}`
    );

    // c. client → {"t":"msg","d":"up"} arrives at the host as {"t":"msg","cid":<cid>,"d":"up"}; host → {"t":"msg","cid":<cid>,"d":"down"} arrives at the client as {"t":"msg","d":"down"}
    client1.ws.send(JSON.stringify({ t: "msg", d: "up" }));
    const hostMsg = await host1.waitForFrame(
      (f) => f && f.t === "msg" && f.cid === cid1 && f.d === "up"
    );
    assert(hostMsg.d === "up", "Host did not receive client msg frame");

    host1.ws.send(JSON.stringify({ t: "msg", cid: cid1, d: "down" }));
    const clientMsg = await client1.waitForFrame(
      (f) => f && f.t === "msg" && f.d === "down"
    );
    assert(clientMsg.d === "down", "Client did not receive host msg frame");
    console.log(
      "PASS: c. bidirectional message routing (client -> host, host -> client)"
    );

    // d. sending the text "ping" on either leg is answered with "pong"
    client1.ws.send("ping");
    await client1.waitForFrame((f) => f === "pong");

    host1.ws.send("ping");
    await host1.waitForFrame((f) => f === "pong");
    console.log("PASS: d. ping answered with pong on both legs");

    // e. a 1 MiB "d" payload round-trips intact
    const largeData = "X".repeat(1024 * 1024);
    client1.ws.send(JSON.stringify({ t: "msg", d: largeData }));
    const hostLarge = await host1.waitForFrame(
      (f) => f && f.t === "msg" && f.cid === cid1 && f.d === largeData
    );
    assert(hostLarge.d === largeData, "Host did not receive intact 1 MiB payload");

    host1.ws.send(JSON.stringify({ t: "msg", cid: cid1, d: largeData }));
    const clientLarge = await client1.waitForFrame(
      (f) => f && f.t === "msg" && f.d === largeData
    );
    assert(
      clientLarge.d === largeData,
      "Client did not receive intact 1 MiB payload"
    );
    console.log("PASS: e. 1 MiB payload round-trips intact");

    // f. a second host joining closes the first with code 4000 and receives "open" for the existing client
    const host2 = connect(`${wsBase}/v1/rooms/${roomId}/host`);
    await host2.waitForOpen();
    const h1Close = await host1.waitForClose();
    assert(
      h1Close.code === 4000,
      `Host 1 close code was ${h1Close.code}, expected 4000`
    );
    const h2Open = await host2.waitForFrame(
      (f) => f && f.t === "open" && f.cid === cid1
    );
    assert(
      h2Open.cid === cid1,
      "Host 2 did not receive open frame for existing client"
    );
    console.log(
      "PASS: f. second host closes first with 4000 and receives open for existing client"
    );

    // g. host → {"t":"kick","cid":...} closes that client with code 4001
    host2.ws.send(
      JSON.stringify({ t: "kick", cid: cid1, reason: "revoked by host" })
    );
    const c1Close = await client1.waitForClose();
    assert(
      c1Close.code === 4001,
      `Client 1 close code was ${c1Close.code}, expected 4001`
    );
    console.log("PASS: g. host kick closes client with code 4001");

    // h. a client closing makes the host receive {"t":"closed","cid":...}
    const client2 = connect(`${wsBase}/v1/rooms/${roomId}/client`);
    await client2.waitForOpen();
    const h2Open2 = await host2.waitForFrame(
      (f) => f && f.t === "open" && f.cid !== cid1
    );
    const cid2 = h2Open2.cid;
    client2.ws.close(1000, "client voluntary close");
    const h2ClosedFrame = await host2.waitForFrame(
      (f) => f && f.t === "closed" && f.cid === cid2
    );
    assert(
      h2ClosedFrame.cid === cid2,
      "Host 2 did not receive closed frame for client 2"
    );
    console.log(
      `PASS: h. client closing makes host receive closed frame (cid=${cid2})`
    );

    // i. the 17th simultaneous client in one room is closed with 4002
    const clients = [];
    for (let i = 0; i < 16; i++) {
      const c = connect(`${wsBase}/v1/rooms/${roomId}/client`);
      clients.push(c);
    }
    await Promise.all(clients.map((c) => c.waitForOpen()));
    await Promise.all(
      clients.map((c) =>
        c.waitForFrame((f) => f && f.t === "host" && f.online === true)
      )
    );

    const client17 = connect(`${wsBase}/v1/rooms/${roomId}/client`);
    const c17Close = await client17.waitForClose();
    assert(
      c17Close.code === 4002,
      `17th client close code was ${c17Close.code}, expected 4002`
    );

    for (let i = 0; i < 16; i++) {
      assert(
        clients[i].ws.readyState === 1,
        `Client ${i} was unexpectedly closed`
      );
    }
    for (let i = 0; i < 15; i++) {
      clients[i].ws.close(1000, "cleanup");
    }
    console.log(
      "PASS: i. 17th simultaneous client in one room is closed with 4002"
    );

    // j. the live host closing makes the remaining clients receive {"t":"host","online":false}
    const lastClient = clients[15];
    host2.ws.close(1000, "host leaving");
    const offlineFrame = await lastClient.waitForFrame(
      (f) => f && f.t === "host" && f.online === false
    );
    assert(
      offlineFrame.online === false,
      "Last client did not receive host online: false"
    );
    lastClient.ws.close(1000, "cleanup");
    console.log(
      "PASS: j. live host closing makes remaining clients receive {t: 'host', online: false}"
    );

    // k. GET /v1/health returns {"ok":true,"service":"foxpilot-relay","protocol":1}; GET /v1/rooms/<valid id>/host WITHOUT upgrade returns 426; an invalid room id returns 404
    const healthRes = await fetch(`${httpBase}/v1/health`);
    assert(
      healthRes.status === 200,
      `Health endpoint returned status ${healthRes.status}`
    );
    const healthJson = await healthRes.json();
    assert(
      healthJson.ok === true &&
        healthJson.service === "foxpilot-relay" &&
        healthJson.protocol === 1,
      `Health JSON was ${JSON.stringify(healthJson)}`
    );

    const noUpgradeRes = await fetch(`${httpBase}/v1/rooms/${roomId}/host`);
    assert(
      noUpgradeRes.status === 426,
      `Room without upgrade returned status ${noUpgradeRes.status}`
    );
    const noUpgradeText = await noUpgradeRes.text();
    assert(
      noUpgradeText.includes("Expected a WebSocket upgrade"),
      `Expected 426 text, got: ${noUpgradeText}`
    );

    const invalidRoomRes = await fetch(`${httpBase}/v1/rooms/invalid!/host`);
    assert(
      invalidRoomRes.status === 404,
      `Invalid room returned status ${invalidRoomRes.status}`
    );
    const invalidRoomText = await invalidRoomRes.text();
    assert(
      invalidRoomText.includes("Not found"),
      `Expected 404 text, got: ${invalidRoomText}`
    );

    console.log(
      "PASS: k. GET /v1/health returns 200, room without upgrade returns 426, invalid room returns 404"
    );

    console.log("\nALL SMOKE TESTS PASSED!");
    process.exit(0);
  } catch (err) {
    console.error("\nFAIL:", err);
    process.exit(1);
  }
}

run();

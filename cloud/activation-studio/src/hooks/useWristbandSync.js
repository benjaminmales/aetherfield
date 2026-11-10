import { useCallback, useRef, useState } from "react";
import { DEFAULT_BRIDGE_URL, sendAuraCommand } from "../lib/bandSync";

export default function useWristbandSync() {
  const [realSyncEnabled, setRealSyncEnabled] = useState(false);
  const [syncTransport, setSyncTransport] = useState("webserial");
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE_URL);
  const [syncStatus, setSyncStatus] = useState("Idle");
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialSupported] = useState(
    () => typeof navigator !== "undefined" && !!navigator.serial?.requestPort
  );

  const serialPortRef = useRef(null);
  const serialWriterRef = useRef(null);
  const serialWriteChainRef = useRef(Promise.resolve());

  const openSerialPort = useCallback(async (port) => {
    await port.open({ baudRate: 115200 });
    if (!port.writable) throw new Error("Selected serial port is not writable");
    serialPortRef.current = port;
    serialWriterRef.current = port.writable.getWriter();
    serialWriteChainRef.current = Promise.resolve();
    setSerialConnected(true);
    setSyncStatus("Web Serial connected");
  }, []);

  const connectWebSerial = useCallback(async () => {
    try {
      if (!navigator.serial?.requestPort) {
        setSyncStatus("Web Serial not supported in this browser");
        return;
      }
      const port = await navigator.serial.requestPort();
      await openSerialPort(port);
    } catch (err) {
      if (err?.name === "NotFoundError") {
        setSyncStatus("No port selected.");
      } else {
        setSyncStatus(err?.message || "Failed to connect Web Serial");
      }
    }
  }, [openSerialPort]);

  const disconnectWebSerial = useCallback(async () => {
    try {
      if (serialWriterRef.current) {
        await serialWriterRef.current.close();
        serialWriterRef.current.releaseLock();
      }
      if (serialPortRef.current) {
        await serialPortRef.current.close();
      }
      serialWriterRef.current = null;
      serialPortRef.current = null;
      setSerialConnected(false);
      setSyncStatus("Web Serial disconnected");
    } catch (err) {
      setSyncStatus(err?.message || "Failed to disconnect Web Serial");
    }
    serialWriteChainRef.current = Promise.resolve();
  }, []);

  const sendLed = useCallback(
    async (led) => {
      if (!realSyncEnabled) return false;
      if (syncTransport === "webserial" && !serialConnected) {
        setSyncStatus("Connect Web Serial first");
        return false;
      }
      if (syncTransport === "bridge" && !String(bridgeUrl || "").trim()) {
        setSyncStatus("Set bridge URL");
        return false;
      }
      try {
        const { writeChain } = await sendAuraCommand(
          {
            transport: syncTransport,
            bridgeUrl,
            writer: serialWriterRef.current,
            writeChain: serialWriteChainRef.current,
          },
          led
        );
        if (syncTransport === "webserial") {
          serialWriteChainRef.current = writeChain;
        }
        setSyncStatus(`Sent aura ${led.mode} ${led.rate} RGB(${led.r},${led.g},${led.b})`);
        return true;
      } catch (e) {
        setSyncStatus(e?.message || "Band sync failed");
        return false;
      }
    },
    [bridgeUrl, realSyncEnabled, serialConnected, syncTransport]
  );

  const wristbandReady = Boolean(
    realSyncEnabled &&
      (syncTransport === "webserial" ? serialConnected : String(bridgeUrl || "").trim().length > 0)
  );

  return {
    realSyncEnabled,
    setRealSyncEnabled,
    syncTransport,
    setSyncTransport,
    bridgeUrl,
    setBridgeUrl,
    syncStatus,
    serialConnected,
    serialSupported,
    connectWebSerial,
    disconnectWebSerial,
    sendLed,
    wristbandReady,
  };
}

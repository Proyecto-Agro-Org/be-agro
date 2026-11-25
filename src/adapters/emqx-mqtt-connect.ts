import type { MqttFactory } from './emqx-mqtt-broker.adapter.js';

// BE13-11D — the ONLY place that loads the MQTT client library (MQTT.js 5.16.1, pinned in package.json). LOCAL_TEST_ONLY
// laboratory wiring. The module is loaded through a non-literal specifier on purpose: its own .d.ts chain pulls DOM-only types
// (worker-timers) that this project's `lib: ["ES2022"]` does not provide, and `skipLibCheck` was NOT enabled because it changes
// the type inference of unrelated dependencies (verified: it broke existing mongoose typings). The factory is typed locally.
export async function loadMqttJsFactory(): Promise<MqttFactory> {
  const specifier: string = 'mqtt';
  const module = await import(specifier) as { default: { connect(url: string, options?: object): unknown } };
  return (url, options) => module.default.connect(url, options) as ReturnType<MqttFactory>;
}

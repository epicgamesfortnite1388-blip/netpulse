import { describe, expect, it } from 'vitest';

import { parseUnixPing, parseWindowsPing } from '../src/util/pingParse';

const EN_OUTPUT = `Pinging 1.1.1.1 [1.1.1.1] with 32 bytes of data:
Reply from 1.1.1.1: bytes=32 time=14ms TTL=58
Reply from 1.1.1.1: bytes=32 time=13ms TTL=58
Request timed out.
Reply from 1.1.1.1: bytes=32 time=15ms TTL=58

Ping statistics for 1.1.1.1:
    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),
Approximate round trip times in milli-seconds:
    Minimum = 13ms, Maximum = 15ms, Average = 14ms`;

const RU_OUTPUT = `Обмен пакетами с 1.1.1.1 [1.1.1.1] с 32 байтами данных:
Ответ от 1.1.1.1: число байт=32 время=14мс TTL=58
Ответ от 1.1.1.1: число байт=32 время=13мс TTL=58
Превышен интервал ожидания для запроса.
Ответ от 1.1.1.1: число байт=32 время=15мс TTL=58

Статистика Ping для 1.1.1.1:
    Пакетов: отправлено = 4, получено = 3, потеряно = 1 (25% потерь)
Приблизительное время приема-передачи в мс:
    Минимальное = 13мс, Максимальное = 15мс, Среднее = 14мс`;

const DE_OUTPUT = `Ping wird ausgefhrt fr 1.1.1.1 mit 32 Bytes Daten:
Antwort von 1.1.1.1: Bytes=32 Zeit=13ms TTL=58
Zeitberschreitung der Anforderung.
Antwort von 1.1.1.1: Bytes=32 Zeit=14ms TTL=58
Zeitberschreitung der Anforderung.

Ping-Statistik fr 1.1.1.1:
    Pakete: Gesendet = 4, Empfangen = 2, Verloren = 2 (50% Verlust),
Ca. Zeitangaben in Millisek.:
    Minimum = 13ms, Maximum = 14ms, Mittelwert = 13ms`;

const ALL_LOST = `Pinging 192.0.2.99 [192.0.2.99] with 32 bytes of data:
Request timed out.
Request timed out.
Request timed out.
Request timed out.

Ping statistics for 192.0.2.99:
    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),`;

describe('parseWindowsPing (English locale)', () => {
  const parsed = parseWindowsPing(EN_OUTPUT, 4);
  it('extracts per-sample latencies', () => {
    expect(parsed.samples).toHaveLength(4);
    expect(parsed.samples[0]).toMatchObject({ ok: true, ms: 14 });
    expect(parsed.samples[2]).toMatchObject({ ok: false, ms: null });
  });
  it('reads statistics block', () => {
    expect(parsed.lossPct).toBe(25);
    expect(parsed.min).toBe(13);
    expect(parsed.max).toBe(15);
    expect(parsed.avg).toBe(14);
    expect(parsed.sent).toBe(4);
    expect(parsed.received).toBe(3);
  });
  it('reports full parse quality', () => {
    expect(parsed.quality).toBe('full');
  });
});

describe('parseWindowsPing (Russian locale)', () => {
  const parsed = parseWindowsPing(RU_OUTPUT, 4);
  it('extracts latencies from время=..мс lines', () => {
    expect(parsed.samples[0]).toMatchObject({ ok: true, ms: 14 });
    expect(parsed.samples[2]).toMatchObject({ ok: false });
    expect(parsed.lossPct).toBe(25);
    expect(parsed.min).toBe(13);
    expect(parsed.avg).toBe(14);
  });
});

describe('parseWindowsPing (German locale)', () => {
  const parsed = parseWindowsPing(DE_OUTPUT, 4);
  it('extracts latencies from Zeit=..ms lines', () => {
    expect(parsed.samples[0]).toMatchObject({ ok: true, ms: 13 });
    expect(parsed.samples[1]).toMatchObject({ ok: false });
    expect(parsed.lossPct).toBe(50);
    expect(parsed.sent).toBe(4);
    expect(parsed.received).toBe(2);
    expect(parsed.min).toBe(13);
    expect(parsed.avg).toBe(13);
  });
});

describe('parseWindowsPing (all packets lost)', () => {
  const parsed = parseWindowsPing(ALL_LOST, 4);
  it('reports 100% loss with no latencies', () => {
    expect(parsed.samples.every((s) => !s.ok)).toBe(true);
    expect(parsed.lossPct).toBe(100);
    expect(parsed.received).toBe(0);
    expect(parsed.min).toBeNull();
  });
});

describe('parseUnixPing', () => {
  it('parses standard Linux output', () => {
    const out = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=13.4 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=14.2 ms

--- 1.1.1.1 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1001ms
rtt min/avg/max/mdev = 13.4/13.8/14.2/0.4 ms`;
    const parsed = parseUnixPing(out, 2);
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[0]?.ms).toBeCloseTo(13.4);
    expect(parsed.lossPct).toBe(0);
    expect(parsed.min).toBeCloseTo(13.4);
    expect(parsed.avg).toBeCloseTo(13.8);
    expect(parsed.max).toBeCloseTo(14.2);
  });
});

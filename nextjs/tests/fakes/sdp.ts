// Builds a syntactically valid SDP answer for a WHEP (recvonly) offer, so a real
// Chromium accepts it in setRemoteDescription(). ICE never completes against
// it (the candidates don't exist) - that's intended; tests only need the
// signalling round-trip to succeed.

type Section = {
  kind: string
  proto: string
  payloads: string[]
  mid: string
  direction: string
  lines: string[]
}

const DIRECTIONS: Record<string, string> = {
  recvonly: 'sendonly',
  sendonly: 'recvonly',
  sendrecv: 'sendrecv',
  inactive: 'inactive',
}

function parseSections(offer: string): Section[] {
  const sections: Section[] = []
  let current: Section | null = null
  for (const raw of offer.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('m=')) {
      const [kind, , proto, ...payloads] = line.slice(2).split(' ')
      current = {
        kind,
        proto,
        payloads,
        mid: String(sections.length),
        direction: 'sendrecv',
        lines: [],
      }
      sections.push(current)
    } else if (current) {
      if (line.startsWith('a=mid:')) current.mid = line.slice(6)
      else if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))
        current.direction = line.slice(2)
      else current.lines.push(line)
    }
  }
  return sections
}

const FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  ((i * 37 + 11) % 256).toString(16).padStart(2, '0').toUpperCase(),
).join(':')

export function answerFor(offerSdp: string): string {
  const sections = parseSections(offerSdp)
  if (sections.length === 0) throw new Error('answerFor: offer has no m= sections')

  const out = [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${sections.map((s) => s.mid).join(' ')}`,
    'a=msid-semantic: WMS *',
  ]

  for (const s of sections) {
    if (s.kind === 'application') {
      // Data channel section: echo it back.
      out.push(
        `m=application 9 ${s.proto} ${s.payloads.join(' ')}`,
        'c=IN IP4 0.0.0.0',
        `a=mid:${s.mid}`,
        'a=ice-ufrag:fakeufrag',
        'a=ice-pwd:fakeicepwdfakeicepwd0123',
        `a=fingerprint:sha-256 ${FINGERPRINT}`,
        'a=setup:passive',
        'a=sctp-port:5000',
      )
      continue
    }
    // Answer with the offer's first payload type, copying its rtpmap/fmtp.
    const pt = s.payloads[0]
    const codecLines = s.lines.filter(
      (l) => l.startsWith(`a=rtpmap:${pt} `) || l.startsWith(`a=fmtp:${pt} `),
    )
    out.push(
      `m=${s.kind} 9 UDP/TLS/RTP/SAVPF ${pt}`,
      'c=IN IP4 0.0.0.0',
      `a=mid:${s.mid}`,
      `a=${DIRECTIONS[s.direction] ?? 'sendrecv'}`,
      'a=rtcp-mux',
      'a=ice-ufrag:fakeufrag',
      'a=ice-pwd:fakeicepwdfakeicepwd0123',
      `a=fingerprint:sha-256 ${FINGERPRINT}`,
      'a=setup:passive',
      ...codecLines,
    )
  }
  return out.join('\r\n') + '\r\n'
}

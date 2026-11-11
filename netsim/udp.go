package netsim

func (s *sim) runUDP() {
	type chunkKey struct{ message, seq int }
	delivered := map[chunkKey]bool{}
	for i, m := range s.opts.Messages {
		base := s.result.MessageOffsets[i]
		data := m.Data
		s.at(m.AtMs, func() {
			// A large message becomes several datagrams. An empty one is one
			// empty datagram.
			for off := 0; off == 0 || off < len(data); off += s.opts.MSS {
				chunk := data[off:min(off+s.opts.MSS, len(data))]
				p := Packet{
					Kind: "DGRAM", From: "client", Seq: base + off, Len: len(chunk),
					Message: i, Preview: preview(chunk),
				}
				s.send(p, udpHeader, func(p Packet) {
					// The application sees a duplicate datagram, but the
					// rebuilt data does not change, so it is counted once.
					key := chunkKey{p.Message, p.Seq}
					if !delivered[key] {
						delivered[key] = true
						s.deliver(p, p.Seq, chunk)
					}
				})
			}
		})
	}
	s.run()
	s.result.Stats.Complete = s.result.Stats.BytesDelivered == len(s.stream)
}

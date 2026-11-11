package netsim

import "math/rand"

func newTestRand(seed int64) *rand.Rand { return rand.New(rand.NewSource(seed)) }

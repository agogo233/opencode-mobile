package mobiletsnet

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

// acceptScript feeds a scripted sequence of Accept() results. Once the script
// is exhausted it blocks forever, like an idle listener.
type acceptScript struct {
	results []error
	calls   int
}

func (a *acceptScript) Accept() (net.Conn, error) {
	i := a.calls
	a.calls++
	if i < len(a.results) {
		return nil, a.results[i]
	}
	select {}
}

func (a *acceptScript) Close() error   { return nil }
func (a *acceptScript) Addr() net.Addr { return nil }

func waitAcceptExit(t *testing.T, done chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("accept loop did not exit within 5s")
	}
}

func registerTestForward(f *Forwarder, item *forward) {
	f.forwardMu.Lock()
	f.forwards[item.Forward.ID] = item
	f.forwardMu.Unlock()
}

func TestAcceptLoopRetriesTransientErrors(t *testing.T) {
	f := New()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener := &acceptScript{
		results: []error{
			errors.New("too many open files"), // transient: must be retried
			net.ErrClosed,                     // listener closed: clean exit
		},
	}
	item := &forward{
		Forward:  Forward{ID: "test-forward"},
		listener: listener,
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	registerTestForward(f, item)

	go f.acceptLoop(ctx, nil, item)
	waitAcceptExit(t, item.done)

	if listener.calls < 2 {
		t.Fatalf("accept calls = %d, want >= 2 (transient error must be retried)", listener.calls)
	}
	if got := f.Status().ForwardCount; got != 0 {
		t.Fatalf("forward count = %d, want 0 after exit", got)
	}
}

func TestAcceptLoopExitsOnContextCancel(t *testing.T) {
	f := New()
	ctx, cancel := context.WithCancel(context.Background())
	item := &forward{
		Forward:  Forward{ID: "test-forward-ctx"},
		listener: &acceptScript{results: []error{errors.New("some accept error")}},
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	registerTestForward(f, item)

	go f.acceptLoop(ctx, nil, item)
	// The first Accept fails while the context is still live, so the loop
	// enters its backoff sleep; cancelling must wake it up and exit.
	time.Sleep(50 * time.Millisecond)
	cancel()
	waitAcceptExit(t, item.done)
}

package mobiletsnet

// NewForwarder is a gomobile-friendly constructor. gobind would render the
// package-level New as a Java method named "new", which javac rejects.
func NewForwarder() *Forwarder { return New() }

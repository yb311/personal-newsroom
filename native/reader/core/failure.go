package core

// Failure is an error with a stable reason code the app can explain to people.
type Failure struct {
	Reason string `json:"reason"`
	Detail string `json:"detail,omitempty"`
}

func (f *Failure) Error() string { return f.Reason + ": " + f.Detail }

func fail(reason, detail string) *Failure { return &Failure{Reason: reason, Detail: detail} }

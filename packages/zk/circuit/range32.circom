pragma circom 2.0.0;

// 32-bit range: public min and max, private value.
// A satisfying proof shows min <= value <= max without revealing value.
template Bits32() {
    signal input in;
    signal bits[32];
    var acc = 0;
    var place = 1;
    for (var i = 0; i < 32; i++) {
        bits[i] <-- (in >> i) & 1;
        bits[i] * (bits[i] - 1) === 0;
        acc += bits[i] * place;
        place *= 2;
    }
    acc === in;
}

template Range32() {
    signal input value;
    signal input min;
    signal input max;
    component below = Bits32();
    component above = Bits32();
    below.in <== value - min;
    above.in <== max - value;
}

component main {public [min, max]} = Range32();

var registers = [];
for (var i = 0; i < 16; i++) {
	registers.push(0);
}

var flags = {
	CARRY: false,
	ZERO: false,
	NEGATIVE: false,
	OVERFLOW: false,
	PARITY: false
}

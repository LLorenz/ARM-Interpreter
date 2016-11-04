const MAX_INTEGER = Math.pow(2, 32);

function assert(bool) {
	if (!bool) {
		console.trace("Error in assertion");
	}
}

function getNthBit(bit, number) {
	return (number >> bit) % 2;
}

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

//IIFE for scoping reasons
var commandTree = (function() {
	var commandList = [
	];

	function arith(arithOperator, writeStatus, result, firstOp, secondOp) {
		assert(arguments.length == 5);
		result = getRegisterFromArgument(result);
		firstOp = registers[getRegisterFromArgument(firstOp)];
		secondOp = evalFlexibleOperator(secondOp);
		result = arithOperator(writeStatus, firstOp, secondOp);
	}

	[
		["ADD", function(writeStatus, first, second) {
			var result = (first + second) % MAX_INTEGER;
			if (writeStatus) {
				flags.CARRY = (result < first);
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result % MAX_INTEGER);
				/*
				 * Overflow if signed bits are
				 *
				 * first | second | result
				 * ------+--------+-------
				 *   0   |    0   |   1
				 *   0   |    1   | never
				 *   1   |    0   | never
				 *   1   |    1   |   0
				 */
				flags.OVERFLOW = getNthBit(31, first) == getNthBit(31, second) && getNthBit(31, first) != getNthBit(31, result);
			}
			return result;
		}],
		["SUB", function(writeStatus, first, second) {
			var result = (first + second) % MAX_INTEGER;
			if (writeStatus) {
				flags.CARRY = (result <= first); // ARM Architecture Reference Manual, p 50
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result % MAX_INTEGER);
				/*
				 * Overflow if signed bits are
				 *
				 * first | second | result
				 * ------+--------+-------
				 *   0   |    0   | never
				 *   0   |    1   |   1
				 *   1   |    0   |   0
				 *   1   |    1   | never
				 */
				flags.OVERFLOW = getNthBit(31, first) != getNthBit(31, second) && getNthBit(31, first) != getNthBit(31, result);
			}
			return result;
		}]
	].forEach(function(array) {
		var newCommandListElement = [array[0] + "<cond><S>", arith.bind(array[1])];
		commandList.push(newCommandListElement);
	});

	// TODO add transformation from list to tree
}());

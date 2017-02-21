const MAX_INTEGER = Math.pow(2, 32);

// Constructor for exceptions encountered during parsing.
function ParseException(message) {
	this.name = "ParseException";
	this.message = message;
	this.stack = (new Error()).stack;
};

ParseException.prototype = Object.create(Error.prototype)

// Constructor for exceptions encountered during runtime.
function RuntimeException(message) {
	this.name = "ParseException";
	this.message = message;
	this.stack = (new Error()).stack;
};

RuntimeException.prototype = Object.create(Error.prototype)

// checks condition assumed for assembler instruction operands
function assert(bool, message) {
	if (!bool) {
		throw new ParseException(message);
	}
}

// returns bit at position n, whereby bit 0 is the lowest bit.
function getNthBit(bit, number) {
	return (number >> bit) % 2;
}

var registers = [];
for (var i = 0; i < 16; i++) {
	registers.push(0);
}

var memory = new Uint8Array(1024*1024) //TODO should be somehow dynamically allocated

var flags = {
	CARRY: false,
	ZERO: false,
	NEGATIVE: false,
	OVERFLOW: false,
	PARITY: false
}

/* commandMap is a map. Key is the command name, value is a operation-
 * generating function. Operation-generating functions are evaluated at parse
 * time and get all operands. They return a function which is evaluated at
 * execution time and changes the registers and flags according to operation
 * specification and operands. Its construction is a bit complicated (see
 * below), for that reason, it is wrapped inside of a IIFE.
 */
var commandMap = (function() {
	var returner = new Map();

	/* Many operations on ARM have different opcodes, but do practically the same.
	 * This is, among other reasons, because of the S flag, which defines whether
	 * flags should be set, and conditional execution. We try to solve this
	 * problem by defining the function populateCommandMap which populates
	 * commandMap with operations belonging to the same "opcode family".
	 *
	 * populateCommandMap takes two arguments, the first being a string with the
	 * command name and wildcards <S> for the S flag and <cond> for conditional.
	 * The second argument is a function which is only executed if <cond> is true.
	 * If the <S> argument is not used, the signature is like a commandMap
	 * argument, if the <S> argument is used, there is a writeStatus argument
	 * before which defines whether status flags should be changed after
	 * operation execution.
	 */
	function populateCommandMap(name, command) {
		function populateCommandMapConditionsSolved(name, command) {
			/* TODO implement arguments length checks for command. Must be done here,
			 * only we know whether one of the arguments is writeStatus and whether we
			 * must therefore subtract one from argument count.
			 */
			if (name.indexOf("<S>") != -1) {
				returner.set(name.replace("<S>", "" ), command.bind(null, false));
				returner.set(name.replace("<S>", "S"), command.bind(null, true));
			} else {
				returner.set(name, command);
			}
		}

		var conditionCodes = [
			["EQ", function() { return FLAGS.ZERO; }],
			["NE", function() { return !FLAGS.ZERO; }],
			["CS", function() { return FLAGS.CARRY; }],
			["HS", function() { return FLAGS.CARRY; }],
			["CC", function() { return !FLAGS.CARRY; }],
			["LO", function() { return !FLAGS.CARRY; }],
			["MI", function() { return FLAGS.NEGATIVE; }],
			["PL", function() { return !FLAGS.NEGATIVE; }],
			["VS", function() { return FLAGS.OVERFLOW; }],
			["VC", function() { return !FLAGS.OVERFLOW; }],
			["HI", function() { return FLAGS.CARRY && !FLAGS.ZERO; }],
			["LS", function() { return !FLAGS.CARRY || FLAGS.ZERO; }],
			["GE", function() { return FLAGS.NEGATIVE == FLAGS.OVERFLOW; }],
			["LT", function() { return FLAGS.NEGATIVE != FLAGS.OVERFLOW; }],
			["GT", function() { return !FLAGS.ZERO && FLAGS.NEGATIVE == FLAGS.OVERFLOW; }],
			["LE", function() { return FLAGS.ZERO || FLAGS.NEGATIVE != FLAGS.OVERFLOW; }],
			["AL", function() { return true; }],
			["", function() { return true; }],
		]

		/* We first do the <cond> part and let populateCommandMapConditionsSolved
		 * do the rest
		 */
		if (name.indexOf("<cond>") == -1) {
			populateCommandMapConditionsSolved(name, command);
		} else {
			conditionCodes.forEach(function(conditionArray) {
				populateCommandMapConditionsSolved(name.replace("<cond>", conditionArray[0]), function() {
					// this operation shall be executed if condition is true
					var operation = command.apply(null, arguments);
					return function() {
						if (conditionArray[1]()) {
							operation();
						}
					}
				});
			});
		}
	}

	/* Returns a function which, when invoked, sets the content of the register denoted by registerString.
	 */
	function setRegisterFunction(registerString) {
		registerString = registerString.toLowerCase();
		var regex = /^r([0-9]|1[0-5])$/;
		var registerStringArray = registerString.match(regex);
		assert(registerStringArray, registerString + " is invalid, it must match the regular expression " + regex);
		var registerIndex = registerStringArray[1];
		return function(value) {
			registers[registerIndex] = value;
		}
	}

	/* Returns a function which, when invoked, returns the content of the register denoted by registerString.
	 */
	function getRegisterFunction(registerString) {
		registerString = registerString.toLowerCase();
		var regex = /^r([0-9]|1[0-5])$/;
		var registerStringArray = registerString.match(regex);
		assert(registerStringArray, registerString + " is invalid, it must match the regular expression " + regex);
		var registerIndex = registerStringArray[1];
		return function(value) {
			return registers[registerIndex];
		}
	}

	/* Returns the number denoted by the numeric constant. If this is not a
	 * numeric constant, a ParseException is thrown.
	 */
	function parseNumericConstant(constant) {
		if (constant.match(/^#[0-9]+$/)) {
			return parseInt(constant.substr(1), 10);
		}

		if (constant.match(/^#0x[0-9a-fA-F]+$/)) {
			return parseInt(constant.substr(3), 16);
		}

		if (constant.match(/^#&[0-9a-fA-F]+$/)) {
			return parseInt(constant.substr(3), 16);
		}

		if (constant.match(/^#[2-9]_[0-9]+$/)) {
			throw new ParseException("Custom bases are not yet supported"); //TODO
		}

		if (constant.match(/^'.'$/)) {
			throw new ParseException("Chars are not yet supported"); //TODO
		}

		throw new ParseException(flexOpFirstPart + " is not a valid constant");

		/* TODO there also are numeric expressions, e. g. #(13+27). They are
		 * currently not supported
		 */
	}

	/* Evaluates a flexible second operand and returns a function which, when invoked,
	 * returns a flexible second operand.
	 *
	 */
	function evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart) {
		// first, assume this is a constant.
		var constant;
		try {
			constant = parseNumericConstant(flexOpFirstPart);
		} catch(e) {
			// this is no numeric constant. Don't throw yet, it might be something else.
		}

		if (constant != undefined) {
			/* TODO only 8-bit pattern rotated by an even number of bits are allowed
			 * by the ARM standard. This is currently not checked.
			 */
			assert(!flexOpSecondPart, "Can't parse flexible operator, did you add a parameter too much?");
			return function() {
				return constant;
			}
		}

		// well, it is not a constant. So, at least the first part must be a register
		var firstPartValue = getRegisterFunction(flexOpFirstPart);

		if (!flexOpSecondPart) {
			// no shift op, we are done here.
			return firstPartValue;
		}

		// there might be multiple whitespace characters between shift op and operand
		var flexOpSecondPart = flexOpSecondPart.replace(/\s\s+/g, ' ').split(" ");
		if (flexOpSecondPart.length != 2) {
			// there must be a shift operation and a shift operand
			throw new ParseException("Cannot parse arguments");
		}

		flexOpSecondPart[1] = parseNumericConstant(flexOpSecondPart[1]);
		if (flexOpSecondPart[0] == "ASR") {
			return function() {
				var value = firstPartValue();
				var signedness = getNthBit(31, value);

				return (value >> flexOpSecondPart[1]) % MAX_INTEGER;
			}
		}

		throw new ParseException("Only ASR is implemented yet"); //TODO
	}

	/* ARITHMETIC OPERATIONS (ADD, SUB, RSB, ADC, SBC, and RSC)
	 * All 6 operations are implemented in a similar way. Therefore, we define a
	 * function arith which takes (among others) an argument arith which will
	 * define operation-specific details, like which flags should be set.
	 *
	 * arith is then bound with the operation names. It now has the signature
	 * commandList functions should have and is registered as such.
	 */
	function arith(arithOperator, writeStatus, result, firstOp, flexOpFirstPart, flexOpSecondPart) {
		assert(arguments.length == 5 || arguments.length == 6, "Argument count wrong, expected 3 or 4, got " + (arguments.length - 2));
		var setResult = setRegisterFunction(result);
		var getFirstOp = getRegisterFunction(firstOp);
		var getSecondOp = evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart);
		return function() {
			setResult(arithOperator(writeStatus, getFirstOp(), getSecondOp()));
		}
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
			var result = (first - second) % MAX_INTEGER;
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
		}],
		["RSB", function(writeStatus, first, second) {
			var result = (second - first) % MAX_INTEGER;
			if (writeStatus) {
				flags.CARRY = (result <= second); // ARM Architecture Reference Manual, p 50
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
				flags.OVERFLOW = getNthBit(31, first) != getNthBit(31, second) && getNthBit(31, second) != getNthBit(31, result);
			}
			return result;
		}],
		["ADC", function(writeStatus, first, second) {
			/* This is another way to handle it
			 * var result = (first + second);
			 * if (FLAGS.CARRY) {result += 1;}
			 * result = result % MAX_INTEGER;
			 *
			 * Probably the if-clause is slighty faster than multiple calculations.
			 */
			if (FLAGS.CARRY) {
				var result = (first + second + 1) % MAX_INTEGER;
			} else {
				var result = (first + second) % MAX_INTEGER;
			}
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
		["SBC", function(writeStatus, first, second) {
			if (FLAGS.CARRY) {
				var result = (first - second) % MAX_INTEGER;
			} else {
				var result = (first - second - 1) % MAX_INTEGER;
			}
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
		}],
		["RSC", function(writeStatus, first, second) {
			if (FLAGS.CARRY) {
				var result = (second - first) % MAX_INTEGER;
			} else {
				var result = (second - first - 1) % MAX_INTEGER;
			}
			if (writeStatus) {
				flags.CARRY = (result <= second); // ARM Architecture Reference Manual, p 50
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
				flags.OVERFLOW = getNthBit(31, first) != getNthBit(31, second) && getNthBit(31, second) != getNthBit(31, result);
			}
			return result;
		}]
	].forEach(function(array) {
		populateCommandMap(array[0] + "<cond><S>", arith.bind(null, array[1]));
	});

	/* MOVING OPERATIONS (MOV, MVN)
	 * 
	 */
	function mov(movOperator, writeStatus, result, flexOpFirstPart, flexOpSecondPart) {
		//assert(arguments.length == 4 || arguments.length == 5, "Argument count wrong, expected 2 or 3, got " + (arguments.length - 2));
		var setResult = setRegisterFunction(result);
		var getValue = evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart);
		return function() {
			setResult(movOperator(writeStatus, getValue()));
		}
	}
	
	[
		["MOV", function(writeStatus, value) {
			var result = value;
			if (writeStatus) {
				ZERO = (result == 0);
				NEGATIVE = (result < 0);
				// change C according to eval of second op
				// dont affect V flag
			}
			return result; 
		}],
		["MVN", function(writeStatus, value) {
		   var result = ~ value;
		   if (writeStatus) {
				ZERO = (result == 0);
				NEGATIVE = (result < 0);
				// change C according to eval of second op
				// dont affect V flag
		   }
		   return result;
		}]
	].forEach(function(array) {
		populateCommandMap(array[0] + "<cond><S>", mov.bind(null, array[1]));
	});

	populateCommandMap("LDR<cond>", function(result, source, offset) {
		assert(arguments.length == 2 || arguments.length == 3, "Argument count wrong, expected 32 or 3, got " + arguments.length);
		assert(source.charAt(0) == "[", "Labels aren't supported yet"); // everything except labels is indirectand in []. TODO

		assert((arguments.length == 2 && source.charAt(source.length - 1) == "]")
	       || arguments.length == 3 && offset.charAt(offset.length - 1) == "]");

		if (arguments.length == 2) {
			var getIndirectReference = getRegisterFunction(source.substr(1, source.length - 2).trim());
			var setResult = setRegisterFunction(result);

			return function() {
				setResult(memory[getIndirectReference()]);
			}
		}
	});
	populateCommandMap("STR<cond>", function(result, source, offset) {
		assert(arguments.length == 2 || arguments.length == 3, "Argument count wrong, expected 32 or 3, got " + arguments.length);
		assert(source.charAt(0) == "[", "Labels aren't supported yet"); // everything except labels is indirectand in []. TODO

		assert((arguments.length == 2 && source.charAt(source.length - 1) == "]")
	       || arguments.length == 3 && offset.charAt(offset.length - 1) == "]");

		if (arguments.length == 2) {
			var getIndirectReference = getRegisterFunction(source.substr(1, source.length - 2).trim());
			var getResult = getRegisterFunction(result);

			return function() {

				memory[getIndirectReference()] = getResult();
			}
		}
	})

	return returner;
}());

const MAX_INTEGER = Math.pow(2, 32);

// Constructor for exceptions encountered during parsing.
function ParseException(message) {
	this.name = "ParseException";
	this.message = message;
	this.stack = (new Error()).stack;
};

ParseException.prototype = Object.create(Error.prototype)

// Constructor for exceptions encountered during parsing.
function UnknownLabelException(message) {
	this.name = "UnknownLabelException";
	this.message = message;
	this.stack = (new Error()).stack;
};

UnknownLabelException.prototype = Object.create(ParseException.prototype)

// Constructor for exceptions encountered during runtime.
function RuntimeException(message) {
	this.name = "ParseException";
	this.message = message;
	this.stack = (new Error()).stack;
};

RuntimeException.prototype = Object.create(Error.prototype)

var labelsMatched = false;
var symbolTable = {};
var labelCallbacks = {};
function matchLabels() {
  for (label in symbolTable) {
    if (labelCallbacks[label]) {
      labelCallbacks[label].forEach(function(callbackItem) {
        callbackItem.callback(symbolTable[label]);
      })
      delete labelCallbacks[label];
    }
  }
  for (label in labelCallbacks) {
    labelCallbacks.label.forEach(function(callbackItem) {
 		  throw new UnknownLabelException(callbackItem.errorString);
    })
  }
	labelsMatched = true;
}

// js modulo incorrect for negative values
function convToUInt32(value) {
	value = value % MAX_INTEGER;
	if (value < 0) {
		value += MAX_INTEGER;
	}
	return value;
}

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
 * specification and operands. Iff a command changes the PC (B, BL etc.), the
 * property isBranch on the Operation-generating function must be set true. This
 * is important for execution.
 *
 * CommandMap construction is a bit complicated (see below), for that reason, it
 * is wrapped inside of a IIFE.
 */
var commandMap = (function() {
	var returner = new Map();

	/* Many operations on ARM have different opcodes, but do practically the same.
	 * This is, among other reasons, because of the S flag, which defines whether
	 * flags should be set, and conditional execution. We try to solve this
	 * problem by defining the function populateCommandMap which populates
	 * commandMap with operations belonging to the same "opcode family".
	 *
	 * populateCommandMap takes two or three arguments.
	 * The first being a string with the command name and wildcards <S> for the S
	 * flag and <cond> for conditional.
	 * The second argument is a function which is only executed if <cond> is true.
	 * If the <S> argument is not used, the signature is like a commandMap
	 * argument, if the <S> argument is used, there is a writeStatus argument
	 * before which defines whether status flags should be changed after
	 * operation execution.
	 * The third argument is a truthy value which is true iff the command is a
	 * branching instruction. We use the value to set isBranch in the commandMap.
	 */
	function populateCommandMap(name, command, isBranch) {
		function populateCommandMapConditionsSolved(name, command) {
			/* TODO implement arguments length checks for command. Must be done here,
			 * only we know whether one of the arguments is writeStatus and whether we
			 * must therefore subtract one from argument count.
			 */
			if (name.indexOf("<S>") != -1) {
				var func = command.bind(null, false);
				func.isBranch = isBranch;
				returner.set(name.replace("<S>", "" ), func);
				func = command.bind(null, true);
				func.isBranch = isBranch;
				returner.set(name.replace("<S>", "S"), func);
			} else {
				command.isBranch = isBranch;
				returner.set(name, command);
			}
		}

		var conditionCodes = [
			["EQ", function() { return flags.ZERO; }],
			["NE", function() { return !flags.ZERO; }],
			["CS", function() { return flags.CARRY; }],
			["HS", function() { return flags.CARRY; }],
			["CC", function() { return !flags.CARRY; }],
			["LO", function() { return !flags.CARRY; }],
			["MI", function() { return flags.NEGATIVE; }],
			["PL", function() { return !flags.NEGATIVE; }],
			["VS", function() { return flags.OVERFLOW; }],
			["VC", function() { return !flags.OVERFLOW; }],
			["HI", function() { return flags.CARRY && !flags.ZERO; }],
			["LS", function() { return !flags.CARRY || flags.ZERO; }],
			["GE", function() { return flags.NEGATIVE == flags.OVERFLOW; }],
			["LT", function() { return flags.NEGATIVE != flags.OVERFLOW; }],
			["GT", function() { return !flags.ZERO && flags.NEGATIVE == flags.OVERFLOW; }],
			["LE", function() { return flags.ZERO || flags.NEGATIVE != flags.OVERFLOW; }],
			["AL", function() { return true; }],
			["", function() { return true; }]
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

	function getLabelFunction(which, errorString) {
	  assert(!labelsMatched, "Labels are already matched");
	  var address;
	  labelCallbacks[which] = labelCallbacks[which] || [];
		labelCallbacks[which].push({
			callback: function(addressToSet) {
				address = addressToSet;
			},
			errorString: "Unknown label " + which
		});
	  return function() {
			assert(address != undefined, "Unknown error. This shouldn't happen. Maybe matchLabels() wasn't called")
	    return address;
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
		var firstPartValue;

		try {
			firstPartValue = getRegisterFunction(flexOpFirstPart);
		} catch (e) {
			throw new ParseException("Can't parse " + flexOpFirstPart + " as constant or as register.");
		}
		if (!flexOpSecondPart) {
			// no shift op, we are done here.
			return firstPartValue;
		}

		// there might be multiple whitespace characters between shift op and operand
		var flexOpSecondPart = flexOpSecondPart.replace(/\s\s+/g, ' ').split(" ");
		if (flexOpSecondPart.length == 1) {
			// RRX = extended Rotate right.. right out > carry-flag > left in - always rotates exactly one bit
			if (flexOpSecondPart[0].toUpperCase() == "RRX") {
				return function() {
					var value = firstPartValue();
					out = getNthBit(0, value);
					value = value >>> 1;
					value = value | (flags.CARRY << 31);
					// registers[7] = out;  debugging reasons
					flags.CARRY = (out)? true : false;
					return convToUInt32(value);
				}
			}
		}
		if (flexOpSecondPart.length != 2) {
			// there must be a shift operation and a shift operand
			// TODO: this is wrong, for RRX no operand allowed
			throw new ParseException("Cannot parse arguments");
		}

		// TODO: this can not only be a number but a register as well. change Parser
		flexOpSecondPart[1] = parseNumericConstant(flexOpSecondPart[1]);
		if (flexOpSecondPart[0].toUpperCase() == "ASR") {
			return function() {
				var value = firstPartValue();
				return convToUInt32((value >> flexOpSecondPart[1])); // Shift right will with 1's
			}
		}
		if (flexOpSecondPart[0].toUpperCase() == "LSR") {
			return function() {
				var value = firstPartValue();
				return convToUInt32((value >>> flexOpSecondPart[1])); // Shift right will with 0's
			}
		}
		if (flexOpSecondPart[0].toUpperCase() == "LSL") {
			return function() {
				var value = firstPartValue();
				return convToUInt32((value << flexOpSecondPart[1]));
			}
		}
		// ROR = rotate to right.. right out > left in
		if (flexOpSecondPart[0].toUpperCase() == "ROR") {
			return function() {
				var value = firstPartValue();
				for (i = 0; i < flexOpSecondPart[1]; i++) {
					out = getNthBit(0, value);
					value = value >>> 1;
					value = value | (out << 31);
				}
				return convToUInt32(value);
			}
		}

		throw new ParseException("There is no bitshift-operator called " + flexOpSecondPart[0] + "!"); // TODO: Replace String
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
			var result = convToUInt32((first + second));
			if (writeStatus) {
				flags.CARRY = (result < first);
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result);
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
			var result = convToUInt32(first - second);
			if (writeStatus) {
				flags.CARRY = (result <= first); // ARM Architecture Reference Manual, p 50
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result);
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
			var result = convToUInt32((second - first));
			if (writeStatus) {
				flags.CARRY = (result <= second); // ARM Architecture Reference Manual, p 50
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result);
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
			 * if (flags.CARRY) {result += 1;}
			 * result = result % MAX_INTEGER;
			 *
			 * Probably the if-clause is slighty faster than multiple calculations.
			 */
			if (flags.CARRY) {
				var result = convToUInt32(first + second + 1);
			} else {
				var result = convToUInt32(first + second);
			}
			if (writeStatus) {
				flags.CARRY = (result < first);
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result);
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
			if (flags.CARRY) {
				var result = convToUInt32(first - second);
			} else {
				var result = convToUInt32(first - second - 1);
			}
			if (writeStatus) {
				flags.CARRY = (result <= first); // ARM Architecture Reference Manual, p 50
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result);
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
			if (flags.CARRY) {
				var result = convToUInt32(second - first);
			} else {
				var result = convToUInt32(second - first - 1);
			}
			if (writeStatus) {
				flags.CARRY = (result <= second); // ARM Architecture Reference Manual, p 50
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result);
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
				flags.ZERO = (result == 0);
				flags.NEGATIVE = (result < 0);
				// change C according to eval of second op
				// dont affect V flag
			}
			return result; 
		}],
		["MVN", function(writeStatus, value) {
		   var result = convToUInt32(~value);
		   if (writeStatus) {
				flags.ZERO = (result == 0);
				flags.NEGATIVE = (getNthBit(31,result) ? true : false);
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

	function branch(link, whereTo) {
		var whereToContennt;
		try {
			whereToContent = getRegisterFunction(whereTo);
		} catch (e) {
			if (!e instanceof ParseException) {
				throw e;
			}

			// whereTo is not a register, so it must be a label
			whereToContent = getLabelFunction(whereTo, whereTo + " is neither register nor label");
		}

		return function() {
			if (link) {
				// save the next instruction for jumping back
				registers[12] = registers[12] + 1;
			}
			registers[15] = whereToContent();
		}
	}

	populateCommandMap("B<cond>", branch.bind(null, false), true);
	populateCommandMap("BL<cond>", branch.bind(null, true), true);

	return returner;
}());

function Command(commandString, lineNumber) {
	commandString = commandString.trim();
	var opcodeLength = commandString.indexOf(" ");
	//TODO das deckt definitiv nicht alle Fälle ab!
	if (opcodeLength == -1 && commandString.charAt(commandString.length - 1) == ':') {
		// this is a line with a label only.
		symbolTable[commandString.substr(0, opcodeLength - 1).trim()] = lineNumber;
		// return a noop
		return function() {}
	} else if (commandString.charAt(opcodeLength - 1) == ':') {
		// this is a line with a label and a following opcode.
		symbolTable[commandString.substr(0, opcodeLength - 1).trim()] = lineNumber;
		// return a noop
		return Command.call(this, commandString.substr(opcodeLength), lineNumber);
	}
	if (opcodeLength == -1) {
		// no spaces in command. This command consists of opcode only.
		opcodeLength = commandString.length;
	}
	var opcodeString = commandString.substr(0, opcodeLength).toUpperCase();
	var options = commandString.substr(opcodeLength + 1).split(",").map(arg => String.prototype.trim.call(arg));

	var commandFactory = commandMap.get(opcodeString);
	if (commandFactory == undefined) {
		window.alert("Unknown opcode " + opcodeString);
		return;
	}

	var command = commandFactory.apply(undefined, options);
	command.isBranch = commandFactory.isBranch;
	return command;
}

function Assembly(instructions) {
	/* Label matching structures are currently shared between multiple assemblys.
	 * We reset these structures here.
	 */
	//TODO one set of structures per Assembly
	symbolTable = {};
	labelCallbacks = {};
	labelsMatched = false;
	instructions = instructions.map(Command);

	matchLabels();
	this.step = function() {
		assert(labelsMatched, "You somehow didn't match the labels. This shouldn't be possible.");
		var instructionToExecute = instructions[registers[15]];

		if (!instructionToExecute) {
			throw new RuntimeException("R15 at index " + registers[15] + ", there is no assembly.");
		}

		instructionToExecute();
		if (!instructionToExecute.isBranch) {
			//This is NOT a branch. Therefore, we increment R15 to point to the next instruction.
			registers[15]++;
		}
	}
}

// Hack to export relevant objects for testing in Node.js (without browser) into global object.
// For the ease of testing, we are currently not using the module.exports facilities.
// TODO as soon as we have a stable interface, export that interface, preferably with module.exports.
if (module && module.exports) {
	global.registers = registers;
	global.Assembly = Assembly;
	global.Command = Command;
}

"use strict";


	// ugly hack: We sometimes need to give additional information to the command factory. This is done via this construct. For example, B and BL need the memory address to calculate the offset of the target address.
var commandOptions;

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

RuntimeException.prototype = Object.create(Error.prototype);

var labelsMatched = false;
var symbolTable = {};
var labelCallbacks = {};
function matchLabels() {
	for (var label in symbolTable) {
		if (labelCallbacks[label]) {
			labelCallbacks[label].forEach(function (callbackItem) {
				callbackItem.callback(symbolTable[label]);
			})
			delete labelCallbacks[label];
		}
	}
	for (label in labelCallbacks) {
		console.log(label);
		labelCallbacks[label].forEach(function (callbackItem) {

			throw new UnknownLabelException(callbackItem.errorString);
		})
	}
	labelsMatched = true;
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

	throw new ParseException(constant + " is not a valid constant");

	/* TODO there also are numeric expressions, e. g. #(13+27). They are
	 * currently not supported
	 */
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

var memory = new Uint8Array(1024 * 1024) //TODO should be somehow dynamically allocated

	// array of undoObjects. Each undoObject has property register (registerss copied) and memory (object which associates memory address to value).

	var undoSteps = [];

function newUndoStep() {
	var undoRegisters = {};
	for (i = 0; i < 16; i++) {
		undoRegisters[i] = registers[i];
	}
	undoSteps.push({
		registers: undoRegisters,
		memory: {}
	});
}

function setMemoryAddress(address, value) {
	if (undoSteps.length != 0 && undoSteps[undoSteps.length - 1].memory[address] === undefined) {
		// if there already is a value for undoing, it is older. Then, we use that value.
		undoSteps[undoSteps.length - 1].memory[address] = memory[address];
	}

	memory[address] = value;
}

function undoLastStep() {
	console.log("before", undoSteps);
	var stepToUndo = undoSteps.pop();
	console.log("after", undoSteps);
	for (i = 0; i < 16; i++) {
		registers[i] = stepToUndo.registers[i];
	}

	for (var address in stepToUndo.memory) {
		if (stepToUndo.memory.hasOwnProperty(address)) {
			console.log("Undoing ", address);
			memory[address] = stepToUndo.memory[address];
		}
	}
}

var flags = {
	CARRY: false,
	ZERO: false,
	NEGATIVE: false,
	OVERFLOW: false
}

/* commandMap is a map. Key is the command name, value is a operation-
 * generating function. Operation-generating functions are evaluated at parse
 * time and get all operands. They return an array of function/byte pairs. The
 * bytes represent the opcode. Functions are executed at runtime and 
 * change the registers and flags according to operation specification and
 * operands. Iff a command changes the PC (B, BL etc.), the property isBranch on
 * the Operation-generating function must be set true. This is important for 
 * execution.
 *
 * CommandMap construction is a bit complicated (see below), for that reason, it
 * is wrapped inside of a IIFE.
 */
var commandMap = (function () {
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
				returner.set(name.replace("<S>", ""), func);
				func = command.bind(null, true);
				func.isBranch = isBranch;
				returner.set(name.replace("<S>", "S"), func);
			} else {
				command.isBranch = isBranch;
				returner.set(name, command);
			}
		}

		var conditionCodes = [
			["EQ", 0b0000, function () {
					return flags.ZERO;
				}
			],
			["NE", 0b0001, function () {
					return !flags.ZERO;
				}
			],
			["CS", 0b0010, function () {
					return flags.CARRY;
				}
			],
			["HS", 0b0010, function () {
					return flags.CARRY;
				}
			],
			["CC", 0b0011, function () {
					return !flags.CARRY;
				}
			],
			["LO", 0b0011, function () {
					return !flags.CARRY;
				}
			],
			["MI", 0b0100, function () {
					return flags.NEGATIVE;
				}
			],
			["PL", 0b0101, function () {
					return !flags.NEGATIVE;
				}
			],
			["VS", 0b0110, function () {
					return flags.OVERFLOW;
				}
			],
			["VC", 0b0111, function () {
					return !flags.OVERFLOW;
				}
			],
			["HI", 0b1000, function () {
					return flags.CARRY && !flags.ZERO;
				}
			],
			["LS", 0b1001, function () {
					return !flags.CARRY || flags.ZERO;
				}
			],
			["GE", 0b1010, function () {
					return flags.NEGATIVE == flags.OVERFLOW;
				}
			],
			["LT", 0b1011, function () {
					return flags.NEGATIVE != flags.OVERFLOW;
				}
			],
			["GT", 0b1100, function () {
					return !flags.ZERO && flags.NEGATIVE == flags.OVERFLOW;
				}
			],
			["LE", 0b1101, function () {
					return flags.ZERO || flags.NEGATIVE != flags.OVERFLOW;
				}
			],
			["AL", 0b1110, function () {
					return true;
				}
			],
			["", 0b1110, function () {
					return true;
				}
			]
		]

		/* We first do the <cond> part and let populateCommandMapConditionsSolved
		 * do the rest
		 */
		if (name.indexOf("<cond>") == -1) {
			populateCommandMapConditionsSolved(name, command);
		} else {
			conditionCodes.forEach(function (conditionArray) {
				populateCommandMapConditionsSolved(name.replace("<cond>", conditionArray[0]), function () {
					// this operation shall be executed if condition is true
					var operation = command.apply(null, arguments);
					var bytecode = function() {
						var localBytecode = typeof operation.bytecode == 'function' ? operation.bytecode() : operation.bytecode;
						return localBytecode | conditionArray[1] << 28;
					}
					return {
						func: function () {
							if (conditionArray[2]()) {
								operation.func ? operation.func() : operation();
							}
						},
						bytecode: bytecode
					}
				});
			});
		}
	}

	/* Returns a function which, when invoked, sets the content of the register denoted by registerString.
	 */
	function setRegisterFunction(registerString) {
		var registerIndex = parseRegister(registerString);
		return function (value) {
			registers[registerIndex] = convToUInt32(value);
		}
	}

	/* Returns a function which, when invoked, returns the content of the register denoted by registerString.
	 */
	function getRegisterFunction(registerString) {
		/*
		registerString = registerString.toLowerCase();
		var regex = /^r([0-9]|1[0-5])$/;
		// catch special registers here 
		var registerStringArray = registerString.match(regex);
		assert(registerStringArray, registerString + " is invalid, it must match the regular expression " + regex);
		*/
		var registerIndex = parseRegister(registerString);
		return function (value) {
			return registers[registerIndex];
		}
	}
	/* necessary helping function to parse also special register names SP, PC, LR correctly
	 */
	function parseRegister(registerString) {
		registerString = registerString.toLowerCase();
		var regex = /^r([0-9]|1[0-5])$/;
		var registerStringArray;
		// catch special registers here
		switch (registerString) {
			case "sp":
				registerStringArray = ["","13"];
				break;
			case "lr":
				registerStringArray = ["","14"];
				break;
			case "pc":
				registerStringArray = ["","15"];
				break;
			default:
				registerStringArray = registerString.match(regex);
				assert(registerStringArray, registerString + " is invalid, it must match the regular expression " + regex);
		}
		var registerIndex = registerStringArray[1];
		// might be a string
		return parseInt(registerIndex, 10);
	}

	function getLabelFunction(which, errorString) {
		assert(!labelsMatched, "Labels are already matched");
		var address;
		labelCallbacks[which] = labelCallbacks[which] || [];
		labelCallbacks[which].push({
			callback: function (addressToSet) {
				address = addressToSet;
					console.log("Label",which,addressToSet)
			},
			errorString: "Unknown label " + which
		});
		return function () {
			console.log("Label",which,address)
			assert(address != undefined, "Unknown error. This shouldn't happen. Maybe matchLabels() wasn't called")
			return address;
		}
	}

	/* Evaluates a flexible second operand and returns a function which, when invoked,
	 * returns a flexible second operand.
	 *
	 */

	function evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart, writeStatus) {
		// first, assume this is a constant.
		var constant;
		var bytecode = 0b000000000000; 
		/* 11    -    7	| 6 - 5 | 4 | 3 - 1
		 * shift amount | shift | 0 |  rm
		 */
		try {
			constant = parseNumericConstant(flexOpFirstPart);
		} catch (e) {
			// this is no numeric constant. Don't throw yet, it might be something else.
		}
		
		if (constant != undefined) {
			assert(!flexOpSecondPart, "Can't parse flexible operator, did you add a parameter too much?");
			
			var shiftBitCounter = 0;
			var value = constant;
			while (value > Math.pow(2, 8) && shiftBitCounter < 16) {
				shiftBitCounter++;
				// rotate 2 bits right (only rotated by even number)
				var out;
				for (i = 0; i < 2; i++) {
					out = getNthBit(0, value);
					value = value >>> 1;
					value = value | (out << 31);
					value = convToUInt32(value);
				}
			}
			if (shiftBitCounter == 16) {
			 throw new ParseException("Illegal Immediate Value - Only  8-bit rotated by an even number of bits allowed by ARM Standard.");
			} else {
				return [function () {
					return constant;
				}, 1, 0b000000000000 | shiftBitCounter << 8 | value];
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
			return [function () {
				return firstPartValue();
			}, 0, 0b000000000000 | parseRegister(flexOpFirstPart)];
		}

		// there might be multiple whitespace characters between shift op and operand
		var flexOpSecondPart = flexOpSecondPart.replace(/\s\s+/g, ' ').split(" ");
		if (flexOpSecondPart.length == 1) {
			// RRX = extended Rotate right.. right out > carry-flag > left in - always rotates exactly one bit
			if (flexOpSecondPart[0].toUpperCase() == "RRX") {
				return [function () {
					var value = firstPartValue();
					out = getNthBit(0, value);
					value = value >>> 1;
					value = value | (flags.CARRY << 31);
					// registers[7] = out;  debugging reasons
					flags.CARRY = (out) ? true : false;
					return convToUInt32(value);
				}, 0, 0b000001100000 | parseRegister(flexOpFirstPart)]
			}
		}
		if (flexOpSecondPart.length != 2) {
			// there must be a shift operation and a shift operand
			// TODO: this is wrong, for RRX no operand allowed
			throw new ParseException("Cannot parse arguments, RRX allows no other operand");
		}

		// TODO: Can we save us the if-clauses in switch below, if we do this as a function call?
		// TODO: specify exceptions
		var value;
		var shiftByRegister = 0;
		var flexOpSecondPartString;
		try {
			value = parseNumericConstant(flexOpSecondPart[1]);
			flexOpSecondPartString = value;
		} catch (e) {
			// This is no numeric constant. Might still be a register
			// throw new ParseException("Can't parse " + flexOpSecondPart[1] + " as constant"); // testing only
		}
		if (value == undefined) {
			try {
				value = getRegisterFunction(flexOpSecondPart[1]);
				shiftByRegister = 1;
				flexOpSecondPartString = flexOpSecondPart[1];
			} catch (e) {
				// No Register --> Error
				throw new ParseException("Can't parse " + flexOpSecondPart[1] + " as constant or as register.");
			}
		}
		flexOpSecondPart[1] = value;
		if (!shiftByRegister && flexOpSecondPartString > Math.pow(2,5)-1) {
			throw new ParseException("Shifted to far");
		}

		/* No breaks needed because return statements
		 *
		 * 	If S is specified, these instructions update the N and Z flags according to the result. TODO: do they
		 *  The C flag is unaffected if the shift value is 0. Otherwise, the C flag is updated to the last bit shifted out.
		 */
		var shiftType;
		switch (flexOpSecondPart[0].toUpperCase()) {
		case "ASR":
			shiftType = 2;
			return [function () {
				var value = firstPartValue();
				
				if (typeof(flexOpSecondPart[1]) === 'function') {
					flexOpSecondPart[1] = flexOpSecondPart[1]();
				}
				if (writeStatus) {
					flags.CARRY = getNthBit(flexOpSecondPart[1] - 1, value) ? true : false;
				}
				return convToUInt32((value >> flexOpSecondPart[1])); // Shift right fill with 1's
			}, shiftByRegister, shiftByRegister ? 0b000000010000 | parseRegister(flexOpSecondPartString) << 8 | shiftType << 5 | parseRegister(flexOpFirstPart)
																					: 0b000000000000 | flexOpSecondPartString << 7 | shiftType << 5 | parseRegister(flexOpFirstPart) ]
		case "LSR":
			shiftType = 1;
			return [function () {
				var value = firstPartValue();
				if (typeof(flexOpSecondPart[1]) === 'function') {
					flexOpSecondPart[1] = flexOpSecondPart[1]();
				}
				if (writeStatus) {
					flags.CARRY = getNthBit(flexOpSecondPart[1] - 1, value) ? true : false;
				}
				return convToUInt32((value >>> flexOpSecondPart[1])); // Shift right fill with 0's
			}, shiftByRegister, shiftByRegister ? 0b000000010000 | parseRegister(flexOpSecondPartString) << 8 | shiftType << 5 | parseRegister(flexOpFirstPart)
																					: 0b000000000000 | flexOpSecondPartString << 7 | shiftType << 5 | parseRegister(flexOpFirstPart) ]
		case "LSL":
			shiftType = 0;
			return [function () {
				var value = firstPartValue();
				if (typeof(flexOpSecondPart[1]) === 'function') {
					flexOpSecondPart[1] = flexOpSecondPart[1]();
				}
				if (writeStatus) {
					flags.CARRY = getNthBit(31 - flexOpSecondPart[1] + 1, value) ? true : false;
				}
				return convToUInt32((value << flexOpSecondPart[1]));
			}, shiftByRegister, shiftByRegister ? 0b000000010000 | parseRegister(flexOpSecondPartString) << 8 | shiftType << 5 | parseRegister(flexOpFirstPart)
																					: 0b000000000000 | flexOpSecondPartString << 7 | shiftType << 5 | parseRegister(flexOpFirstPart) ]
			// ROR = rotate to right.. right out > left in
		case "ROR":
			shiftType = 3;
			return [function () {
				var value = firstPartValue();
				if (typeof(flexOpSecondPart[1]) === 'function') {
					flexOpSecondPart[1] = flexOpSecondPart[1]();
				}
				var out;
				for (i = 0; i < flexOpSecondPart[1]; i++) {
					out = getNthBit(0, value);
					value = value >>> 1;
					value = value | (out << 31);
				}
				flags.CARRY = out ? true : false;
				return convToUInt32(value);
			}, shiftByRegister, shiftByRegister ? 0b000000010000 | parseRegister(flexOpSecondPartString) << 8 | shiftType << 5 | parseRegister(flexOpFirstPart)
																					: 0b000000000000 | flexOpSecondPartString << 7 | shiftType << 5 | parseRegister(flexOpFirstPart) ]
		default:
			throw new ParseException("There is no bitshift-operator called " + flexOpSecondPart[0] + "!");
			break;
		}
	}

	/* ARITHMETIC OPERATIONS (ADD, SUB, RSB, ADC, SBC, and RSC)
	 * All 6 operations are implemented in a similar way. Therefore, we define a
	 * function arith which takes (among others) an argument arith which will
	 * define operation-specific details, like which flags should be set.
	 *
	 * arith is then bound with the operation names. It now has the signature
	 * commandList functions should have and is registered as such.
	 */
	function arith(operatorBits, arithOperator, writeStatus, result, firstOp, flexOpFirstPart, flexOpSecondPart) {
		assert(arguments.length == 6 || arguments.length == 7, "Argument count wrong, expected 3 or 4, got " + (arguments.length - 3));
		var setResult = setRegisterFunction(result);
		var getFirstOp = getRegisterFunction(firstOp);
		var secOpEval = evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart, writeStatus);
		var getSecondOp = secOpEval[0];
		var secondaryI = secOpEval[1];
		var secondaryBC = secOpEval[2];
		return {
			func: function() {
				setResult(arithOperator(writeStatus, getFirstOp(), getSecondOp()));
			},
			bytecode: 0x00000000 | secondaryI << 25 | operatorBits << 21 | writeStatus << 20 | parseRegister(firstOp) << 16 | parseRegister(result) << 12 | secOpEval[2] << 0
		};
	}

	[
		["ADD", 0b0100, function (writeStatus, first, second) {
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
			}
		],
		["SUB", 0b0010, function (writeStatus, first, second) {
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
			}
		],
		["RSB", 0b0011, function (writeStatus, first, second) {
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
			}
		],
		["ADC", 0b0101, function (writeStatus, first, second) {
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
			}
		],
		["SBC", 0b0110, function (writeStatus, first, second) {
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
			}
		],
		["RSC", 0b0111, function (writeStatus, first, second) {
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
			}
		]
	].forEach(function (array) {
		populateCommandMap(array[0] + "<cond><S>", arith.bind(null, array[1], array[2]));
	});
	 
	/* Extended Maths
	 *
	 */
	 function mul(operatorBits, arithOperator, writeStatus, result, firstOp, secondOp) {
		assert(arguments.length == 5 || arguments.length == 6, "Argument count wrong, expected 2 or 3, got " + (arguments.length - 3));
		// result register is optional
		if (arguments.length == 4) {
			var getFirstOp = getRegisterFunction(result);
			var getSecondOp = getRegisterFunction(firstOp);
		}
		else {
			var setResult = setRegisterFunction(result);
			var getFirstOp = getRegisterFunction(firstOp);
			var getSecondOp = getRegisterFunction(secondOp);
		}
		return {
			func: function() {
				setResult(arithOperator(writeStatus, getFirstOp(), getSecondOp()));
			},
			bytecode: writeStatus << 20 | parseRegister(result) << 16 || parseRegister(firstOp) || parseRegister(secondOp) << 8 || 0b10010000
		};
	}
	[
		["MUL", 0x00000000, function(writeStatus,first,second){
			var result = convToUInt32(first * second);
			if (writeStatus) {
				// from Reference: corrupt the C and V flag in ARMv4 - do not affect the C or V flag in ARMv5T and above. 
				// so we do nothing with them
				flags.ZERO = !result;
				flags.NEGATIVE = getNthBit(31, result);
			}
			return result;
		}]
	].forEach(function (array) {
		populateCommandMap(array[0] + "<cond><S>", mul.bind(null, array[1], array[2]));
	});
	
	
	/* LOGICAL OPERATIONS (AND, ORR, EOR, BIC)
	 * All 4 operations are implemented in a similar way, see arith() for comparison
	 */
	// The function to use for logical operators is pretty much identical to the one used for arith operators, as they get the same amount and type of arguments
	function logic(operatorBits, logicalOperator, writeStatus, result, firstOp, flexOpFirstPart, flexOpSecondPart) {
		assert(arguments.length == 6 || arguments.length == 7, "Argument count wrong, expected 3 or 4, got " + (arguments.length - 3));
		var setResult = setRegisterFunction(result);
		var getFirstOp = getRegisterFunction(firstOp);
		var secOpEval = evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart, writeStatus);
		var getSecondOp = secOpEval[0];
		var secondaryI = secOpEval[1];
		var secondaryBC = secOpEval[2];
		return {
			func: function() {
				setResult(logicalOperator(writeStatus, getFirstOp(), getSecondOp()));
			},
			bytecode: 0x00000000 | secondaryI << 25 | operatorBits << 21 | writeStatus << 20 | parseRegister(result) << 16 | parseRegister(firstOp) << 12 | secOpEval[2] << 0
		};
	}
	[
		["AND", 0b0000, function (writeStatus, first, second) {
				var result = (first & second);
				if (writeStatus) {
					// change status accordingly
					flags.ZERO = (result == 0);
					// flags.CARRY results from bitshift-operator
					flags.NEGATIVE = getNthBit(31, result) ? true : false;
				}
				return result;
			}
		],
		["ORR", 0b1100, function (writeStatus, first, second) {
				var result = first | second;
				if (writeStatus) {
					// change status accordingly
					flags.ZERO = (result == 0);
					// flags.CARRY results from bitshift-operator
					flags.NEGATIVE = getNthBit(31, result) ? true : false;
				}
				return result;
			}
		],
		["EOR", 0b0001, function (writeStatus, first, second) {
				var result = first ^ second;
				if (writeStatus) {
					// change status accordingly
					flags.ZERO = (result == 0);
					// flags.CARRY results from bitshift-operator
					flags.NEGATIVE = getNthBit(31, result) ? true : false;
				}
				return result;
			}
		],
		["BIC", 0b1110, function (writeStatus, first, second) {
				var result = first & ~second;
				if (writeStatus) {
					// change status accordingly
					flags.ZERO = (result == 0);
					// flags.CARRY results from bitshift-operator
					flags.NEGATIVE = getNthBit(31, result) ? true : false;
				}
				return result;
			}
		]
	].forEach(function (array) {
		populateCommandMap(array[0] + "<cond><S>", logic.bind(null, array[1], array[2]));
	});

	/* COMPARING OPERATIONS (TST, TEQ, CMP, CMN)
	 * All 4 operations are implemented in a similar way, see arith() for comparison
	 *
	 * The function used for comparing algorithms is slighty differing, as we do have neither a target register nor the set flag directive
	 *
	 * Comparing functions > only set Flags > no returns
	 * TODO:
	 * please test flag setting according to ARM manual
	 * probably clean results as returns (thinking 1/0) would be better than no result
	 */
	// how is comparison handled when called (no writestatus / result needed --> minimize ?
	function comp(operatorBits, compOperator, firstOp, flexOpFirstPart, flexOpSecondPart) {
		// arguments.length - 1 because the first register given is already an argument (because there is no destination)
		assert(arguments.length == 4 || arguments.length == 5, "Argument count wrong, expected 2 or 3, got " + (arguments.length - 2));
		console.log(compOperator, firstOp, flexOpFirstPart, flexOpSecondPart);
		var getFirstOp = getRegisterFunction(firstOp);
		// execute getSecondOp with writeStatus = true
		var writeStatus = true;
		var secOpEval = evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart, writeStatus);
		var getSecondOp = secOpEval[0];
		var secondaryI = secOpEval[1];
		var secondaryBC = secOpEval[2];
		return {
			func: function() {
				compOperator(getFirstOp(), getSecondOp());
			},
			bytecode: 0x00000000 | secondaryI << 25 | operatorBits << 21 | writeStatus << 20 | parseRegister(firstOp) << 16 | secOpEval[2] << 0
		};
	}
	[
		["CMP", 0b1010, function (first, second) {
				var result = convToUInt32(first - second);
				flags.ZERO = (result == 0);
				flags.NEGATIVE = getNthBit(31, result) ? true : false;
				flags.CARRY = !(first - second < 0);
				// flags.OVERFLOW case substraction:
				flags.OVERFLOW = getNthBit(31, first) != getNthBit(31, second) && getNthBit(31, first) != getNthBit(31, result);
			}
		],
		["CMN", 0b1011, function (first, second) {
				// TODO: correct? - reference manual 4.1.14 CMN
				var result = convToUInt32(first + second);
				flags.ZERO = (result == 0);
				flags.NEGATIVE = getNthBit(31, result) ? true : false;
				flags.CARRY = (first + second) >= MAX_INTEGER;
				// flags.OVERFLOW case addition:
				flags.OVERFLOW = getNthBit(31, first) == getNthBit(31, second) && getNthBit(31, first) != getNthBit(31, result);
			}
		],
		["TEQ", 0b1001, function (first, second) {
				var result = convToUInt32(first ^ second);
				flags.ZERO = (result == 0);
				flags.NEGATIVE = getNthBit(31, result) ? true : false;
				// flags.CARRY set from barrelShift
				// flags.OVERFLOW unaffected
			}
		],
		["TST", 0b1000, function (first, second) {
				var result = convToUInt32(first & second);
				flags.ZERO = (result == 0);
				flags.NEGATIVE = getNthBit(31, result) ? true : false;
				// flags.CARRY set from barrelShift
				// flags.OVERFLOW unaffected
			}
		]
	].forEach(function (array) {
		populateCommandMap(array[0] + "<cond>", comp.bind(null, array[1], array[2]));
	});

	/* MOVING OPERATIONS (MOV, MVN)
	 *
	 */
	function mov(operatorBits, movOperator, writeStatus, result, flexOpFirstPart, flexOpSecondPart) {
		assert(arguments.length == 5 || arguments.length == 6, "Argument count wrong, expected 2 or 3, got " + (arguments.length - 3));
		var setResult = setRegisterFunction(result);
		var secOpEval = evalFlexibleOperatorFunction(flexOpFirstPart, flexOpSecondPart, writeStatus);
		var getSecondOp = secOpEval[0];
		var secondaryI = secOpEval[1];
		var secondaryBC = secOpEval[2];
		return {
			func: function() {
			setResult(movOperator(writeStatus, getSecondOp()));
			},
			bytecode: 0x00000000 | secondaryI << 25 | operatorBits << 21 | writeStatus << 20 | parseRegister(result) << 12 | secOpEval[2] << 0
		};
	}

	[
		["MOV", 0b1101, function (writeStatus, value) {
				var result = value;
				if (writeStatus) {
					flags.ZERO = (result == 0);
					flags.NEGATIVE = (result < 0);
					// change C according to eval of second op
					// dont affect V flag
				}
				return result;
			}
		],
		["MVN", 0b1111, function (writeStatus, value) {
				var result = convToUInt32(~value);
				if (writeStatus) {
					flags.ZERO = (result == 0);
					flags.NEGATIVE = (getNthBit(31, result) ? true : false);
					// change C according to eval of second op
					// dont affect V flag
				}
				return result;
			}
		]
	].forEach(function (array) {
		populateCommandMap(array[0] + "<cond><S>", mov.bind(null, array[1], array[2]));
	});

	function ldrStrCalculateAddress() {
		var args = Array.prototype.join.call(arguments, ',');

		if (args.charAt(0) == "=") {
			//TODO wie gehe ich mit dem Bytecode um?
			// label
			return {
				type: 'direct',
				address: getLabelFunction(args.substr(1).trim())
			}
		} else if (args.charAt(0) != "[") {
			//TODO
			// content at address of label
			return {
				type: 'indirect',
				address: getLabelFunction(args)
			}
		}

		var indexType;

		if (args.charAt(0) != "[") {
			throw new ParseException("Unknown LDR/STR instruction type");
		}

		args = args.substr(1).trim();

		if (args.charAt(args.length - 1) == "!") {
			// this is pre indexed
			assert(args.charAt(args.length - 2) == "]", "Unknown LDR/STR instruction type");
			indexType = 1;
			args = args.substr(0, args.length - 2).trim();
		} else if (args.charAt(args.length - 1) == "]") {
			// this is offset
			indexType = 0;
			args = args.substr(0, args.length - 1).trim();
		} else {
			// this must be post-indexed
			indexType = 2;
			var newArgs = args.replace(/^([^,]*)\],/, function(match, p1) {
				return p1 + ",";
			});
			if (newArgs == args) {
				throw new ParseException("Unknown LDR/STR instruction type");
			}
			args = newArgs;
		}
		
		args = args.split(",");

		// We now know the index type. Find out the addressing type.
		var offsetGetterFunction;
		var sourceBytecode;

		var sourceRegisterIndex = parseRegister(args[0]);

		var matches;
		if (args.length == 2) matches = args[1].match(/^([+-]?)(#.*)$/)

		var negative = false;
		if (args.length == 1) {
			// only the register given, handling this as immediate offset of zero
			offsetGetterFunction = function() {
				return 0;
			}
			sourceBytecode = 0;
		} else if (matches) {
			// this is a immediate
			negative = matches[1] == '-';
			var immediateOffset = parseNumericConstant(matches[2]);
			offsetGetterFunction = function() {
				return negative ? -immediateOffset : immediateOffset;
			}
			sourceBytecode = immediateOffset;
		} else {
			// this is either register or scaled register
			if (args.length == 2) {
				args[2] == "LSL #0";
			}

			if (args[1].charAt(0) == '-') {
				negative = true;
			}

			if (negative || args[1].charAt(0) == '+') {
				args[1] = args[1].substr(1).trim();
			}

			var offset = parseRegister(args[1]);

			var shiftFunction;
			var shiftBytecode;

			var shift = args[2].replace(/\s\s+/g, ' ').split(" ");

			switch (shift[0].toUpperCase()) {
			case "RRX":
				shiftFunction = function (value) {
					out = getNthBit(0, value);
					value = value >>> 1;
					value = value | (flags.CARRY << 31);
					// registers[7] = out;  debugging reasons
					flags.CARRY = (out) ? true : false;
					return convToUInt32(value);
				}
				shiftBytecode = 3;
				break;
			case "ASR":
				var shiftWidth = parseNumericConstant(shift[1]);
				assert(shiftWidth >= 1 && shiftWidth <= 32, "ASR shifts must be between 1 and 32");
				shiftFunction = function (value) {
					flags.CARRY = getNthBit(shiftWidth - 1, value);
					return convToUInt32(value >> shiftWidth); // Shift right fill with 1's
				}
				if (shiftWidth == 32) shiftWidth = 0;
				shiftBytecode = 2 | shiftWidth << 2;
				break;
			case "LSR":
				var shiftWidth = parseNumericConstant(shift[1]);
				assert(shiftWidth >= 1 && shiftWidth <= 32, "ASR shifts must be between 1 and 32");
				shiftFunction = function (value) {
					return convToUInt32((value >>> shiftWidth)); // Shift right fill with 0's
				}
				if (shiftWidth == 32) shiftWidth = 0;
				shiftBytecode = 1 | shiftWidth << 2;
				break;
			case "LSL":
				var shiftWidth = parseNumericConstant(shift[1]);
				assert(shiftWidth >= 0 && shiftWidth <= 31, "ASR shifts must be between 1 and 32");
				shiftFunction = function (value) {
					flags.CARRY = getNthBit(31 - shiftWidth + 1, value) ? true : false;
					return convToUInt32((value << shiftWidth));
				}
				shiftBytecode = 0 | shiftWidth << 2;
				break;
			case "ROR":
				var shiftWidth = parseNumericConstant(shift[1]);
				assert(shiftWidth >= 1 && shiftWidth <= 31, "ASR shifts must be between 1 and 32");
				shiftFunction = function (value) {
					var out;
					for (i = 0; i < shiftWidth; i++) {
						out = getNthBit(0, value);
						value = value >>> 1;
						value = value | (out << 31);
					}
					flags.CARRY = out ? true : false;
					return convToUInt32(value);
				}
				shiftBytecode = 3 | shiftWidth << 2;
				break;
			default:
				throw new ParseException("There is no bitshift-operator called " + flexOpSecondPart[0] + "!");
				break;
			}

			offsetGetterFunction = function() {
				return shiftFunction(registers[offset]);
			}

			sourceBytecode = 1 << 25 | shiftBytecode << 5 | offset;	
		}

		var otherBytecodeParts = sourceBytecode | sourceRegisterIndex << 16;
		if (negative) {
			var offsetGetterFunctionOld = offsetGetterFunction;
			offsetGetterFunction = function() {
				return -offsetGetterFunctionOld();
			}
		}
		switch (indexType) {
		case 0:
			// offset
			return {
				func: function() {
					return registers[sourceRegisterIndex] + offsetGetterFunction();
				},
				bytecode: 0b01010000 << 20 | !negative << 23 | otherBytecodeParts
			}
		case 1:
			// pre indexed
			return {
				func: function() {
					registers[sourceRegisterIndex] += offsetGetterFunction();
					return registers[sourceRegisterIndex];
				},
				bytecode: 0b01010010 << 20 | !negative << 23 | otherBytecodeParts
			}
		case 2:
			// post indexed
			return {
				func: function() {
					var returner = registers[sourceRegisterIndex];
					registers[sourceRegisterIndex] += offsetGetterFunction();
					return returner;
				},
				bytecode: 0b01000000 << 20 | !negative << 23 | otherBytecodeParts
			}
		}
	}

	populateCommandMap("LDR<cond>", function (result, source, offset) {
		var setResult = setRegisterFunction(result);
		var reference = ldrStrCalculateAddress.apply(null, Array.prototype.slice.call(arguments, 1));
		return {
			func: function() {
				var address = reference.func();
				setResult(memory[address] +
					  memory[address + 1] * Math.pow(2, 8) +
					  memory[address + 2] * Math.pow(2, 16) +
					  memory[address + 3] * Math.pow(2, 24));
			},
			bytecode: reference.bytecode | parseRegister(result) << 12 | 1 << 20
		}
	});
	populateCommandMap("STR<cond>", function (result, source, offset) {
		var getResult = getRegisterFunction(result);
		var reference = ldrStrCalculateAddress.apply(null, Array.prototype.slice.call(arguments, 1));

		return {
			func: function() {
				var address = reference.func();
				setMemoryAddress(address, getResult() % Math.pow(2, 8));
				setMemoryAddress(address + 1, getResult() >>> 8 % Math.pow(2, 8));
				setMemoryAddress(address + 2, getResult() >>> 16 % Math.pow(2, 8));
				setMemoryAddress(address + 3, getResult() >>> 24 % Math.pow(2, 8));
			},
			bytecode: reference.bytecode | parseRegister(result) << 12
		}
	});

	function parseRegList(type, args) {
		var argument = Array.prototype.join.apply(args);
		assert(argument.charAt(0) == "{", type + "s need to start with a {");
		assert(argument.charAt(argument.length - 1) == "}", type + "s need to end with a }");

		var returner = [];

		argument = argument.substr(1, argument.length - 2).split(",").map(str => str.trim()).forEach(function(registerRange) {
			var colonPosition = registerRange.indexOf("-");
			if (colonPosition == -1) {
				// this is NOT a register range
				returner.push(parseRegister(registerRange));
			} else {
				var begin = parseRegister(registerRange.substr(0, colonPosition));
				var end = parseRegister(registerRange.substr(colonPosition + 1));

				assert(begin < end, registerRange + " is not a valid register range");
				for (var i = begin; i <= end; i++) {
					returner.push(i);
				}
			}
		});

		// sort and filter duplicates. For reference: http://stackoverflow.com/a/9229821
		returner = returner.sort().filter(function(item, pos, ary) {
        return !pos || item != ary[pos - 1];
    });
console.log(returner);
		return returner;
	}
	populateCommandMap("PUSH<cond>", function () {
		var registerList = parseRegList.call(null, "Push", arguments);
		return function() {
			// PUSH is synonymous for STMDB => decrement before
			registers[13] -= 4 * registerList.length;
			registerList.forEach(function(register, index) {
				// TODO copy&paste from STR, refactor in own function
				setMemoryAddress(registers[13] + 4 * index, registers[register] % Math.pow(2, 8));
				setMemoryAddress(registers[13] + 4 * index + 1, registers[register] >>> 8 % Math.pow(2, 8));
				setMemoryAddress(registers[13] + 4 * index + 2, registers[register] >>> 16 % Math.pow(2, 8));
				setMemoryAddress(registers[13] + 4 * index + 3, registers[register] >>> 24 % Math.pow(2, 8));
			});
		}
	});

	populateCommandMap("POP<cond>", function () {
		var registerList = parseRegList.call(null, "Pop", arguments);
		return function() {
			// PUSH is synonymous for LDMIA => increment after
			registerList.forEach(function(register, index) {
				// TODO copy&paste from STR, refactor in own function
				registers[register] = memory[registers[13] + 4 * index] +
				                      memory[registers[13] + 4 * index + 1] * Math.pow(2, 8) +
								              memory[registers[13] + 4 * index + 2] * Math.pow(2, 16) +
								              memory[registers[13] + 4 * index + 3] * Math.pow(2, 24);
			});
			registers[13] += 4 * registerList.length;
		}
	});
	
	// STM/LDM define a lot of helpers, so wrap them in a function
	(function() {
		var addressModes = [
			["", function(register) {
				registers[register] += 4;
				return registers[register] - 4;
			}, false],
			["IA", function(register) {
				registers[register] += 4;
				return registers[register] - 4;
			}, false],
			["IB", function(register) {
				registers[register] += 4;
				return registers[register];
			}, false],
			["DA", function(register) {
				registers[register] -= 4;
				return registers[register] + 4;
			}, true],
			["DB", function(register) {
				registers[register] -= 4;
				return registers[register];
			}, true]
		];
		
		var ops = [
			["STM", function(address, register) {
				setMemoryAddress(address, registers[register] % Math.pow(2, 8));
				setMemoryAddress(address + 1, registers[register] >>> 8 % Math.pow(2, 8));
				setMemoryAddress(address + 2, registers[register] >>> 16 % Math.pow(2, 8));
				setMemoryAddress(address + 3, registers[register] >>> 24 % Math.pow(2, 8));
			}],
			["LDM", function(address, register) {
				registers[register] = memory[address] +
				                      memory[address + 1] * Math.pow(2, 8) +
								              memory[address + 2] * Math.pow(2, 16) +
								              memory[address + 3] * Math.pow(2, 24);
			}]
		];
		
		ops.forEach(function(op) {
			addressModes.forEach(function(addressMode) {
				populateCommandMap(op[0] + addressMode[0] + "<cond>", function(baseRegister) {
					var writeBack = (baseRegister.charAt(baseRegister.length - 1) == '!');
					if (writeBack) {
						baseRegister = baseRegister.substr(0, baseRegister.length - 1).trim();
					}
					baseRegister = parseRegister(baseRegister);
					
					// There is a reg list we need to access. To use parseRegList, we need to cut away the baseRegister
					var regList = Array.prototype.slice.call(arguments, 1);
					console.log(regList);
					regList = parseRegList(op[0], regList);
					if (addressMode[2]) {
						// This is a decrement operation. Reverse regList so that we handle biggest register index first
						regList = regList.reverse();
					}
					return {
						func: function() {
							console.log("Bla")
							var registerBefore = registers[baseRegister];
							regList.forEach(function(registerToConsume) {
								op[1](addressMode[1](baseRegister), registerToConsume);
							});
							if (!writeBack) {
								registers[baseRegister] = registerBefore;
							}
						}, bytecode: 0 //TODO placeholder
					}
				})
			})
		})
	})();

	function branch(link, whereTo) {
		// this is for B and BL. For BX/BLX, see below.
		
		var whereToContent = getLabelFunction(whereTo, whereTo + " is neither register nor label");
		// We now calculate the offset to the target address. We follow instructions on page A4-11 of the ARM Architecture Reference Manual (B, BL -> Usage).
		var baseAddress = commandOptions.memoryAddress + 8;

		return {
			func: function () {
				if (link) {
					// save the next instruction for jumping back
					registers[14] = registers[15] + 4;
				}
				console.log("Branching to " + whereToContent());
				registers[15] = whereToContent();
			},
			bytecode: function() {
				console.log("Here");
				var offset = whereToContent() - baseAddress;
				var negative;
				if (offset < 0) {
					negative = true;
					offset = -offset;
				} else {
					negative = false;
				}

				if (offset % 4 !== 0) {
					throw new ParseException("Trying to jump to " + whereTo + ", but seems to be not aligned");
				}
console.log("offset",offset)
				if ((negative && offset > 33554432) ||
				   (!negative && offset > 33554428)) {
					throw new ParseException("Relative branch to " + whereTo + " out of range");
				}
				
				offset /= 4;
console.log("offset2",offset)
				var immediateSignedThreeByte;

				if (!negative) {
					immediateSignedThreeByte = offset;
				} else {
					immediateSignedThreeByte = convToUInt32((~offset & 0xFFFFFF) + 1);
				}
console.log("immediateSignedThreeByte",immediateSignedThreeByte)
				return 0b101 << 25 | link << 24 | immediateSignedThreeByte
			}
		}
	}
	populateCommandMap("B<cond>", branch.bind(null, false));
	populateCommandMap("BL<cond>", branch.bind(null, true));

	function branchExchange(link, whereTo) {
		// we just assume that we branch to an address which is divisable by 4. If this is not the case, a real processor would either switch to thumb mode (address % 4 == {1, 3}) or invoke undefined behavior (address % 4 == 2).
		var whereToContent = getRegisterFunction(whereTo);
		return {
			func: function () {
				if (link) {
					// save the next instruction for jumping back
					registers[14] = registers[15] + 4;
				}
				console.log("Branching to " + whereToContent());
				registers[15] = whereToContent();
			},
			bytecode: 0b00010010 << 20 | 0xFFFFFF << 8 | 1 << 4 | parseRegister(whereTo) | link << 5
		}
	}

	populateCommandMap("BX<cond>", branchExchange.bind(null, false));
	populateCommandMap("BLX<cond>", branchExchange.bind(null, true));

	return returner;
}
	());
var symbolsToAdd = [];

function addSymbols(memoryAddress) {
	symbolsToAdd.forEach(function(symbolToAdd) {
		console.log("Registering " + symbolToAdd + " at " + memoryAddress);
		symbolTable[symbolToAdd] = memoryAddress;
	});
	symbolsToAdd = [];
}

function Command(commandString, memoryAddress, lineNumber) {
	var isOnlyLabel = commandString.trim().endsWith(":");
	commandString = commandString.trim();
	var opcodeLength = commandString.indexOf(" ");
	if (opcodeLength == -1 || (commandString.indexOf("\t") != -1 && commandString.indexOf("\t") < opcodeLength)) {
		opcodeLength = commandString.indexOf("\t");
	}
	//TODO das deckt definitiv nicht alle Fälle ab!
	if (opcodeLength == -1 && commandString.charAt(commandString.length - 1) == ':') {
		// this is a line with a label only.
		symbolsToAdd.push(commandString.split(":")[0]);
		// return no new commands
		return [];
	} else if (commandString.charAt(opcodeLength - 1) == ':') {
		// this is a line with a label and a following opcode.
		symbolsToAdd.push(commandString.substr(0, opcodeLength - 1).trim());
		return Command.call(this, commandString.substr(opcodeLength), memoryAddress);
	}
	if (commandString.substr(0, 6).toLowerCase() == ".asciz") {
		addSymbols(memoryAddress);
		var string = commandString.substr(7).trim();
		assert(string.charAt(0) == '"' && string.charAt(string.length - 1) == '"', string + " is not a string literal, needs to be quoted (\")");
		string = string.substr(1, string.length - 2);
		string = string.replace("\\0", "\0");
		string = string.replace("\\n", "\n");
		string += "\0" // we need to null terminate the string in memory
		var returner = [];
		for (var i = 0; i < string.length; i++) {
			memory[memoryAddress + i] = string.charCodeAt(i);
			returner.push(function() {
				throw new RuntimeException("Trying to execute .asciz pseudo instruction");
			})
		}

		return returner;
	}
	if (commandString.substr(0, 6).toLowerCase() == ".ascii") {
		addSymbols(memoryAddress);
		var string = commandString.substr(7).trim();
		assert(string.charAt(0) == '"' && string.charAt(string.length - 1) == '"', string + " is not a string literal, needs to be quoted (\")");
		string = string.substr(1, string.length - 2);
		string = string.replace("\\0", "\0");
		string = string.replace("\\n", "\n");
		var returner = [];
		for (var i = 0; i < string.length; i++) {
			memory[memoryAddress + i] = string.charCodeAt(i);
			returner.push(function() {
				throw new RuntimeException("Trying to execute .asciz pseudo instruction");
			})
		}

		return returner;
	}
	if (commandString.substr(0, 6).toLowerCase() == ".space") {
		addSymbols(memoryAddress);
		var amount = parseInt(commandString.substr(7).trim());

		var returner = [];
		for (var i = 0; i < amount; i++) {
			returner.push(function() {
				throw new RuntimeException("Trying to execute .space pseudo instruction");
			})
		}

		return returner;
	}
	if (commandString.substr(0, 5).toLowerCase() == ".byte") {
		addSymbols(memoryAddress);
		// GNU as uses other constant format. This quick hack solves this for most cases.
		var constant = parseNumericConstant("#" + commandString.substr(6).trim());
		memory[memoryAddress] = constant;
		var returner = [];
		returner.push(function() {
			throw new RuntimeException("Trying to execute .byte pseudo instruction");
		})

		return returner;
	}
	if (commandString.substr(0, 5).toLowerCase() == ".word") {
		// GNU as uses other constant format. This quick hack solves this for most cases.
		var constant = parseNumericConstant("#" + commandString.substr(6).trim());
		var returner = [];
		// add padding
		while (memoryAddress % 4) {
			memoryAddress++;
			returner.push(function() {
				throw new RuntimeException("Trying to execute padding");
			})
		}
		addSymbols(memoryAddress);
		setMemoryAddress(memoryAddress, constant % Math.pow(2, 8));
		setMemoryAddress(memoryAddress + 1, constant >>> 8 % Math.pow(2, 8));
		setMemoryAddress(memoryAddress + 2, constant >>> 16 % Math.pow(2, 8));
		setMemoryAddress(memoryAddress + 3, constant >>> 24 % Math.pow(2, 8));
		for (var i = 0; i < 4; i++) {
			returner.push(function() {
				throw new RuntimeException("Trying to execute .space pseudo instruction");
			})
		}

		return returner;
	}
	
	// ignore some compiler directives
	var ignore = false;
	["file",
	"text",
	"align",
	"global",
	"type",
	"size",
	"end",
	"ident",
	"section",
	"comm",
	"data"].forEach(function(directive) {
		if (commandString.substr(0, 1 + directive.length).toLowerCase() == "." + directive) {
			ignore = true;
		}
	})
	
	if (ignore) {
		// ignore directive
		return [];
	}
	
	if (opcodeLength == -1) {
		// no spaces in command. This command consists of opcode only.
		opcodeLength = commandString.length;
	}
	var opcodeString = commandString.substr(0, opcodeLength).toUpperCase();
	var options = commandString.substr(opcodeLength + 1).split(",").map(arg => String.prototype.trim.call(arg));

	var commandFactory = commandMap.get(opcodeString);
	if (commandFactory == undefined) {
		assert(opcodeString == "", "Unknown opcode \"" + opcodeString + "\" on line " + (lineNumber + 1));
		return [];
	}
	commandOptions = {
		memoryAddress: memoryAddress
	};
	var command = commandFactory.apply(null, options);
	
	var returner = [];
	
	// add padding
	while (memoryAddress % 4) {
		memoryAddress++;
		returner.push(function() {
			throw new RuntimeException("Trying to execute padding");
		})
	}
	addSymbols(memoryAddress);
	
	command.func.isBranch = commandFactory.isBranch;
	var dummyCommand = function() {
		throw new RuntimeException("Trying to execute on non-aligned address");
	}
	if (typeof command.bytecode != 'function') {
		var oldBytecode = command.bytecode;
		command.bytecode = function() {
			return oldBytecode;
		}
	}
	setTimeout(function() {
		setMemoryAddress(memoryAddress, command.bytecode() % Math.pow(2, 8));
		setMemoryAddress(memoryAddress + 1, command.bytecode() >>> 8 % Math.pow(2, 8));
		setMemoryAddress(memoryAddress + 2, command.bytecode() >>> 16 % Math.pow(2, 8));
		setMemoryAddress(memoryAddress + 3, command.bytecode() >>> 24 % Math.pow(2, 8));
	}, 0);
	
	returner.push(command.func);
	returner.push(dummyCommand);
	returner.push(dummyCommand);
	returner.push(dummyCommand);
	return returner;
}

function Assembly(instructions, isBreakpoint, printCallback) {
	// in our application, this should always be a function. For generic use, we also support undefined.
	if (!isBreakpoint) {
		isBreakpoint = function () {
			return false;
		}
	}
	/* Label matching structures are currently shared between multiple assemblys.
	 * We reset these structures here.
	 */
	//TODO one set of structures per Assembly
	symbolTable = {"printf": 1000001, "scanNumber": 1000002, "scanString": 1000003};
	labelCallbacks = {};
	labelsMatched = false;
	var commands = [];
	instructions.forEach(function(instruction, lineNumber) {
		Command(instruction, commands.length, lineNumber).forEach(function(command) {
			command.lineNumber = lineNumber;
			commands.push(command);
		});
	});

	matchLabels();
	this.step = function () {
		assert(labelsMatched, "You somehow didn't match the labels. This shouldn't be possible.");
		newUndoStep();
		var instructionToExecute = commands[registers[15]];

		//Check if an instruction exists on the current line
		if (instructionToExecute) {
			var pcBefore = registers[15];
			instructionToExecute();
			// Check if the current instruction is a branch. If not, we increment R15 to point to the next instruction.
			if (pcBefore == registers[15]) {
				// TODO this isn't idiot proof, if the user does MOV pc, pc, this won't work.
				// Maybe use proxy to detect access to R15 by instruction?
				registers[15] += 4;
			}
		} else {
			console.log("R15 at index " + registers[15] + ", there is no assembly.");
			registers[15] += 4;
		}
		if (registers[15] == 1000001) {
		// printf
			var stringFromAddress = function(address) {
				var returner = "";
				for (var i = address; memory[i] != 0; i++) {
					returner += String.fromCharCode(memory[i]);
				}
				return returner;
			}
			var formatString = stringFromAddress(registers[0]);
			var returner = "";
			var currentRegister = 1;
			for (var i = 0; i < formatString.length; i++) {
				if (formatString.substr(i, 1) != "%") {
					returner += formatString.substr(i, 1);
				} else {
					i++;
					switch (formatString.substr(i, 1)) {
						case 'i':
						case 'd':
							returner += (memory[registers[currentRegister]] +
							             memory[registers[currentRegister] + 1] * Math.pow(2, 8) +
											     memory[registers[currentRegister] + 2] * Math.pow(2, 16) +
											     memory[registers[currentRegister] + 3] * Math.pow(2, 24));
					    currentRegister++;
							break;
						case 's':
							returner += stringFromAddress(registers[currentRegister]);
							currentRegister++;
							break;
						default:
						  throw new RuntimeException("Invalid format string escape sequence %" + formatString.substr(i, 1));
					}
				}
			}
			printCallback(returner);
			registers[15] = registers[14];
		}
		if (registers[15] == 1000002) {
			// read integer
			var integer = parseInt(prompt("Please enter integer"), 10);
			setMemoryAddress(registers[0], integer % Math.pow(2, 8));
			setMemoryAddress(registers[0] + 1, integer >>> 16 % Math.pow(2, 8));
			setMemoryAddress(registers[0] + 2, integer >>> 24 % Math.pow(2, 8));
			setMemoryAddress(registers[0] + 3, integer >>> 8 % Math.pow(2, 8));
			registers[15] = registers[14];
		}
		if (registers[15] == 1000003) {
			// read string
			console.log("Here");
			var string = prompt("Please enter string") + "\0";
			for (var i = 0; i < string.length; i++) {
				setMemoryAddress(registers[0] + i, string.charCodeAt(i));
			}
			registers[15] = registers[14];
		}
		console.log(registers[15], commands.length)
		if (registers[15] == commands.length) {
			window.alert("End of program reached");
		}
	}

	this.run = function(doneCallback, stepCallback) {
		var aborted = false;
		var that = this;
		function nextStep() {
			that.step();
			stepCallback();
			if (that.isEnd() || isBreakpoint(registers[15]) || aborted) {
				doneCallback();
			} else {
				setTimeout(nextStep, 0);
			}
		}
		setTimeout(nextStep, 0);
		return function () {
			aborted = true;
		};
	}

	this.isEnd = function() {
		return registers[15] == commands.length;
	}

	this.resetState = function() {
		undoSteps = [];
		for (i = 0; i < 16; i++) {
			registers[i] 	= 0;
		}
		registers[13]   = 1000000;
		registers[14]   = commands.length;
		registers[15]   = symbolTable.main || 0;
		flags.CARRY 		= false;
		flags.ZERO 			= false;
		flags.NEGATIVE 	= false;
		flags.OVERFLOW 	= false;
	}

	this.getLineNumber = function(memoryAddress) {
		return commands[memoryAddress] ? commands[memoryAddress].lineNumber : -1;
	}
	
	this.getInfoForLine = function(lineNumber) {
		// binary search would be faster, but number of lines is probably small => We don't care
		for (var i = 0; i < commands.length; i++) {
			if (commands[i].lineNumber >= lineNumber || i == commands.length - 1) {
				return {
					line: commands[i].lineNumber,
					command: i
				}
			}
		}
	}
}

// Hack to export relevant objects for testing in Node.js (without browser) into global object.
// For the ease of testing, we are currently not using the module.exports facilities.
// TODO as soon as we have a stable interface, export that interface, preferably with module.exports.
if (typeof module != "undefined") {
	global.registers = registers;
	global.Assembly = Assembly;
	global.Command = Command;
}

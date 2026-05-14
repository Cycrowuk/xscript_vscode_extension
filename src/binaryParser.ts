/**
 * binaryParser.ts — XScript .dat binary parser
 *
 * Mirrors CScriptData::loadData() exactly, including C++ struct padding bytes.
 *
 * Key struct sizes verified against MSVC x64 default packing:
 *   DataTypeFileData        = 12 bytes  (1 pad after isObject)
 *   FunctionFileData        = 28 bytes  (1 pad after allowNull, 3 pad at end)
 *   FunctionArgFileData     = 8  bytes
 *   CommandFileData         = 12 bytes  (2 pad at end)
 *   ObjectCommandFileData   = 12 bytes
 *   WareTypeFileData        = 12 bytes  (2 pad at end)
 *   CustomFileData          = 16 bytes  (2 pad before datatype, 2 pad at end)
 *   All others: no padding
 */

import * as fs   from 'fs';
import * as path from 'path';
import {
    XDatabase, XFunction, XProperty, XConstant,
    retTs, pardefToTs, makeParamName,
} from './xmlParser';

// ── Low-level buffer reader ───────────────────────────────────────────────────

class BufReader {
    private buf: Buffer;
    private pos = 0;

    constructor(buf: Buffer) { this.buf = buf; }

    get offset(): number  { return this.pos; }
    get remaining(): number { return this.buf.length - this.pos; }

    readU8():  number { const v = this.buf.readUInt8(this.pos);    this.pos += 1; return v; }
    readU16(): number { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
    readI16(): number { const v = this.buf.readInt16LE(this.pos);  this.pos += 2; return v; }
    readU32(): number { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
    skip(n: number): void { this.pos += n; }

    /** Read `size` latin-1 bytes + 1 NUL terminator → string */
    readStr(size: number): string {
        if (size === 0) { this.pos += 1; return ''; }
        const s = this.buf.slice(this.pos, this.pos + size).toString('latin1');
        this.pos += size + 1;
        return s;
    }

    /** Read a fixed-length NUL-padded char field (no size prefix, no NUL read) */
    readFixedStr(len: number): string {
        const sl  = this.buf.slice(this.pos, this.pos + len);
        this.pos += len;
        const end = sl.indexOf(0);
        return sl.slice(0, end < 0 ? len : end).toString('latin1');
    }
}

// ── Section header (DataFileHeaderRaw) ───────────────────────────────────────
// short version(2) + short count(2) + char[14] = 18 bytes

interface SectionHeader { version: number; count: number; name: string; }

function readHeader(r: BufReader): SectionHeader | null {
    if (r.remaining < 18) { return null; }
    const version = r.readI16();
    const count   = r.readI16();  // short in struct, cast to unsigned on use
    const name    = r.readFixedStr(14);
    return { version, count: count >>> 0, name };
}

// ── Raw data structures ───────────────────────────────────────────────────────

interface RawDataType  { id: number; code: string; name: string; desc: string; isObject: boolean; }
interface RawParDef    { id: number; code: string; name: string; desc: string; flags: number; datatypes: number[]; }
interface RawWare      { id: number; code: string; name: string; desc: string; }
interface RawRace      { id: number; code: string; name: string; desc: string; }
interface RawConstGroup { name: string; desc: string; }
interface RawConstant  { code: string; id: number; subtypeId: number; groupName: string; }
interface RawCommand   { id: string; num: number; name: string; shortName: string; description: string; }
interface RawCommandList { datatypeId: number; name: string; desc: string; commands: Map<number, RawCommand>; }
interface RawArgument  { pardefId: number; desc: string; constGroup: string; }
interface RawFunction  {
    id: number; name: string; desc: string; example: string;
    allowNull: boolean; undefinedArgs: number;
    returnArg: number; returnVarType: number;
    orderItems: string[]; refObjTypeIds: number[];
    returnValueTypeIds: number[]; fnArgs: RawArgument[];
}
interface RawCustomEntry { code: string; desc: string; strID: string; intID: number; }
interface RawCustomData  { datatypeId: number; name: string; desc: string; isStringData: boolean; entries: RawCustomEntry[]; }
interface RawProperty    { name: string; desc: string; getterId: number; setterId: number; }

// ── Section parsers (match loadData() exactly) ────────────────────────────────

// GAMEDATA — GameDataFileData = 14 bytes (7 × u16), no padding
function parseGameData(r: BufReader): void {
    const engineMin = r.readU16();
    const engineMax = r.readU16();
    const texts     = r.readU16();
    const language  = r.readU16();
    const idSize    = r.readU16();
    const dirSize   = r.readU16();
    const nameSize  = r.readU16();
    for (let i = 0; i < texts; i++) { r.readU16(); }  // text prefixes
    r.readStr(idSize);
    r.readStr(dirSize);
    r.readStr(nameSize);
    void engineMin; void engineMax; void language;
}

// DATATYPE — DataTypeFileData = 12 bytes
// id(u32=4) isObject(u8=1) PAD(1) idSize(u16=2) nameSize(u16=2) descSize(u16=2)
function parseOneDataType(r: BufReader): RawDataType {
    const id       = r.readU32();
    const isObject = r.readU8() !== 0;
    r.skip(1);          // ← alignment padding after uchar before ushort
    const idSize   = r.readU16();
    const nameSize = r.readU16();
    const descSize = r.readU16();
    const code = r.readStr(idSize);
    const name = r.readStr(nameSize);
    const desc = r.readStr(descSize);
    return { id, code, name, desc, isObject };
}

// PARDEF — ParDefFileData = 16 bytes (all u32/u16, no padding)
function parseOneParDef(r: BufReader): RawParDef {
    const id       = r.readU32();
    const flags    = r.readU32();
    const idSize   = r.readU16();
    const nameSize = r.readU16();
    const descSize = r.readU16();
    const dtCount  = r.readU16();
    const code = r.readStr(idSize);
    const name = r.readStr(nameSize);
    const desc = r.readStr(descSize);
    const datatypes: number[] = [];
    for (let k = 0; k < dtCount; k++) { datatypes.push(r.readU32()); }
    return { id, code, name, desc, flags, datatypes };
}

// WARES — WareTypeFileData = 12 bytes
// id(u32=4) idSize(u16=2) nameSize(u16=2) descSize(u16=2) PAD(2)
function parseOneWare(r: BufReader): RawWare {
    const id       = r.readU32();
    const idSize   = r.readU16();
    const nameSize = r.readU16();
    const descSize = r.readU16();
    r.skip(2);          // ← trailing padding to u32 alignment
    const code = r.readStr(idSize);
    const name = r.readStr(nameSize);
    const desc = r.readStr(descSize);
    return { id, code, name, desc };
}

// RACES — RaceFileData = 8 bytes (4 × u16, no padding)
function parseOneRace(r: BufReader): RawRace {
    const codeSize = r.readU16();
    const descSize = r.readU16();
    const nameSize = r.readU16();
    const id       = r.readU16();
    const code = r.readStr(codeSize);
    const name = r.readStr(nameSize);
    const desc = r.readStr(descSize);
    return { id, code, name, desc };
}

// CONSTGROUP — ConstGroupFileData = 4 bytes (2 × u16)
function parseOneConstGroup(r: BufReader): RawConstGroup {
    const idSize   = r.readU16();
    const descSize = r.readU16();
    const name = r.readStr(idSize);
    const desc = r.readStr(descSize);
    return { name, desc };
}

// ConstantFileData = 12 bytes (2 × u32 + 2 × u16)
function parseOneConstant(r: BufReader): RawConstant {
    const id        = r.readU32();
    const subtypeId = r.readU32();
    const idSize    = r.readU16();
    const groupSize = r.readU16();
    const code      = r.readStr(idSize);
    const groupName = groupSize > 0 ? r.readStr(groupSize) : '';
    return { code, id, subtypeId, groupName };
}

// CONSTANTNS — ConstantNamespaceFileData = 4 bytes, then count × ConstantFileData
function parseOneConstantNS(r: BufReader): { ns: string; constants: RawConstant[] } {
    const idSize  = r.readU16();
    const entries = r.readU16();
    const ns = r.readStr(idSize);
    const constants: RawConstant[] = [];
    for (let i = 0; i < entries; i++) { constants.push(parseOneConstant(r)); }
    return { ns, constants };
}

// CONSTANTS — one ConstantFileData per j iteration
// (same as parseOneConstant, just a separate call site)

// OBJCMDS — CommandFileData = 12 bytes
// datatype(u32=4) entries(u16=2) nameSize(u16=2) descSize(u16=2) PAD(2)
function parseOneObjCmdList(r: BufReader): RawCommandList {
    const datatypeId = r.readU32();
    const entries    = r.readU16();
    const nameSize   = r.readU16();
    const descSize   = r.readU16();
    r.skip(2);          // ← trailing padding
    const name = r.readStr(nameSize);
    const desc = r.readStr(descSize);
    const commands = new Map<number, RawCommand>();
    // ObjectCommandFileData = 12 bytes (u32 + 4×u16, no padding)
    for (let i = 0; i < entries; i++) {
        const cmdId      = r.readU32();
        const idSize2    = r.readU16();
        const nameSize2  = r.readU16();
        const descSize2  = r.readU16();
        const shortSize  = r.readU16();
        const id    = r.readStr(idSize2);
        const cname = r.readStr(nameSize2);
        const short = r.readStr(shortSize);
        const cdesc = r.readStr(descSize2);
        commands.set(cmdId, { id, num: cmdId, name: cname, shortName: short, description: cdesc });
    }
    return { datatypeId, name, desc, commands };
}

// GFUNC / OFUNC — FunctionFileData = 28 bytes
// id(u32=4) idSize(u16=2) descSize(u16=2) argCount(u16=2)
// allowNull(u8=1) PAD(1) refObj(u16=2) orderCount(u16=2) exampleSize(u16=2)
// returnArg(u16=2) returnType(u16=2) returnCount(u16=2)
// undefinedArgs(u8=1) PAD(3)
function parseOneFunction(r: BufReader): RawFunction {
    const id            = r.readU32();
    const idSize        = r.readU16();
    const descSize      = r.readU16();
    const argCount      = r.readU16();
    const allowNull     = r.readU8() !== 0;
    r.skip(1);          // ← alignment padding after uchar before ushort
    const refObjCount   = r.readU16();
    const orderCount    = r.readU16();
    const exampleSize   = r.readU16();
    const returnArg     = r.readU16();
    const returnType    = r.readU16();
    const returnCount   = r.readU16();
    const undefinedArgs = r.readU8();
    r.skip(3);          // ← trailing padding (struct aligned to u32 = 4 bytes)

    const name    = r.readStr(idSize);
    const desc    = r.readStr(descSize);
    const example = r.readStr(exampleSize);

    // order items: each prefixed by u16 size
    const orderItems: string[] = [];
    for (let i = 0; i < orderCount; i++) {
        const sz = r.readU16();
        if (sz > 0) { orderItems.push(r.readStr(sz)); }
    }

    // refObjType — u32 each
    const refObjTypeIds: number[] = [];
    for (let i = 0; i < refObjCount; i++) { refObjTypeIds.push(r.readU32()); }

    // returnValue — written as `unsigned long val = static_cast<unsigned short>(*itr)`
    // so always 4 bytes per entry
    const returnValueTypeIds: number[] = [];
    for (let i = 0; i < returnCount; i++) { returnValueTypeIds.push(r.readU32()); }

    // FunctionArgFileData = 8 bytes (u32 + 2×u16, no padding)
    const fnArgs: RawArgument[] = [];
    for (let i = 0; i < argCount; i++) {
        const pardefId  = r.readU32();
        const aDescSize = r.readU16();
        const groupSize = r.readU16();
        const argDesc   = r.readStr(aDescSize);
        const constGroup = groupSize > 0 ? r.readStr(groupSize) : '';
        fnArgs.push({ pardefId, desc: argDesc, constGroup });
    }

    return {
        id, name, desc, example, allowNull, undefinedArgs, returnArg,
        returnVarType: returnType, orderItems,
        refObjTypeIds, returnValueTypeIds, fnArgs,
    };
}

// SFUNC — SpecialFuncFileData = 4 bytes (2×u16)
function parseOneSFunc(r: BufReader): void {
    r.readU16(); // id
    r.readU16(); // funcId
}

// SPECIALKEY — SpecialKeyFileData = 4 bytes (2×u16)
function parseOneSpecialKey(r: BufReader): void {
    r.readU16(); // id
    const sz = r.readU16();
    r.readStr(sz);
}

// OTFUNC — ObjectTypeFileData header (4 bytes) + size × ObjectTypeFileData + string
function parseOneOTFuncGroup(r: BufReader): void {
    /* dt = */ r.readU16();
    const size = r.readU16();
    for (let i = 0; i < size; i++) {
        /* funcId = */ r.readU16();
        const nameSize = r.readU16();
        r.readStr(nameSize);
    }
}

// PROPERTIES — PropertiesData = 8 bytes (4×u16)
function parseOneProperty(r: BufReader): RawProperty {
    const nameSize = r.readU16();
    const descSize = r.readU16();
    const getterId = r.readU16();
    const setterId = r.readU16();
    const name = r.readStr(nameSize);
    const desc = r.readStr(descSize);
    return { name, desc, getterId, setterId };
}

// CUSTOM — CustomFileData = 16 bytes
// entries(u16=2) PAD(2) datatype(u32=4) nameSize(u16=2) descSize(u16=2) isString(u16=2) PAD(2)
function parseOneCustom(r: BufReader): RawCustomData {
    const entries    = r.readU16();
    r.skip(2);          // ← padding before u32
    const datatypeId = r.readU32();
    const nameSize   = r.readU16();
    const descSize   = r.readU16();
    const isString   = r.readU16() !== 0;
    r.skip(2);          // ← trailing padding
    const name = r.readStr(nameSize);
    const desc = r.readStr(descSize);

    // CustomEntryFileData = 8 bytes (4×u16), no padding
    const rawEntries: RawCustomEntry[] = [];
    for (let i = 0; i < entries; i++) {
        const codeSize  = r.readU16();
        const eDescSize = r.readU16();
        const idSize    = r.readU16();
        const intID     = r.readU16();
        const code  = r.readStr(codeSize);
        const eDesc = r.readStr(eDescSize);
        const strID = r.readStr(idSize);
        rawEntries.push({ code, desc: eDesc, strID, intID });
    }
    return { datatypeId, name, desc, isStringData: isString, entries: rawEntries };
}

// ── TS type mapping ───────────────────────────────────────────────────────────

function buildDtToTs(dataTypes: RawDataType[]): Map<number, string> {
    const map = new Map<number, string>();
    for (const dt of dataTypes) {
        const code = dt.code.toUpperCase();
        let ts = 'any';
        if      (code === 'DATATYPE_SHIP')    { ts = 'Ship'; }
        else if (code === 'DATATYPE_STATION') { ts = 'Station'; }
        else if (code === 'DATATYPE_SECTOR')  { ts = 'Sector'; }
        else if (code === 'DATATYPE_OBJECT')  { ts = 'XObject'; }
        else if (code === 'DATATYPE_RACE')    { ts = 'Race'; }
        else if (code === 'DATATYPE_WARE')    { ts = 'Ware'; }
        else if (code === 'DATATYPE_INT')     { ts = 'number'; }
        else if (code === 'DATATYPE_STRING')  { ts = 'string'; }
        else if (code === 'DATATYPE_ARRAY')   { ts = 'any[]'; }
        else if (code.includes('TABLE'))      { ts = 'Record<any, any>'; }
        map.set(dt.id, ts);
    }
    return map;
}

function buildPardefTsMap(pardefs: RawParDef[], dtMap: Map<number, string>): Map<number, string> {
    const map = new Map<number, string>();
    for (const pd of pardefs) {
        const fromCode = pardefToTs(pd.code);
        if (fromCode !== 'any') { map.set(pd.id, fromCode); continue; }
        if (pd.datatypes.length === 1) {
            map.set(pd.id, dtMap.get(pd.datatypes[0]) ?? 'any');
        } else if (pd.datatypes.length > 1) {
            map.set(pd.id, pd.datatypes.map(d => dtMap.get(d) ?? 'any').join(' | '));
        } else {
            map.set(pd.id, 'any');
        }
    }
    return map;
}

function retVarTypeToStyle(v: number): 'return' | 'if' | 'no_if' | 'start' | null {
    if (v === 1) { return 'return'; }
    if (v === 2) { return 'if'; }
    if (v === 3) { return 'no_if'; }
    if (v === 4) { return 'start'; }
    return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function parseBinaryDatabase(filePath: string): XDatabase {
    const buf = fs.readFileSync(filePath);
    const r   = new BufReader(buf);

    const root = readHeader(r);
    if (!root || root.name !== 'XSCRIPTDATA') {
        throw new Error(`Not a valid XSCRIPTDATA file (header: '${root?.name ?? '?'}')`);
    }

    // Storage
    const rawDataTypes:  RawDataType[]    = [];
    const rawParDefs:    RawParDef[]      = [];
    const rawWares:      RawWare[]        = [];
    const rawRaces:      RawRace[]        = [];
    const rawConstGroups: RawConstGroup[] = [];
    const rawConstants:  RawConstant[]   = [];
    const rawConstNS     = new Map<string, RawConstant[]>();
    const rawCmdLists:   RawCommandList[] = [];
    const rawGFuncs:     RawFunction[]   = [];
    const rawOFuncs:     RawFunction[]   = [];
    const rawProperties: RawProperty[]   = [];
    const rawCustom:     RawCustomData[] = [];

    // ── Main section loop — mirrors loadData() outer for(i) / inner for(j) ──

    for (let i = 0; i < root.count; i++) {
        const hdr = readHeader(r);
        if (!hdr) { break; }

        for (let j = 0; j < hdr.count; j++) {
            switch (hdr.name) {
                case 'GAMEDATA':    parseGameData(r);                         break;
                case 'DATATYPE':    rawDataTypes.push(parseOneDataType(r));   break;
                case 'PARDEF':      rawParDefs.push(parseOneParDef(r));       break;
                case 'WARES':       rawWares.push(parseOneWare(r));           break;
                case 'RACES':       rawRaces.push(parseOneRace(r));           break;
                case 'CONSTGROUP':  rawConstGroups.push(parseOneConstGroup(r)); break;
                case 'CONSTANTNS': {
                    const { ns, constants } = parseOneConstantNS(r);
                    rawConstNS.set(ns, constants);
                    break;
                }
                case 'CONSTANTS':   rawConstants.push(parseOneConstant(r));   break;
                // OBJCMDS: each j iteration = one full command list
                case 'OBJCMDS':     rawCmdLists.push(parseOneObjCmdList(r));  break;
                case 'GFUNC': {
                    const fn = parseOneFunction(r);
                    rawGFuncs.push(fn);
                    break;
                }
                case 'OFUNC': {
                    const fn = parseOneFunction(r);
                    rawOFuncs.push(fn);
                    break;
                }
                case 'SFUNC':       parseOneSFunc(r);      break;
                case 'SPECIALKEY':  parseOneSpecialKey(r); break;
                // OTFUNC: each j iteration = one datatype group
                case 'OTFUNC':      parseOneOTFuncGroup(r); break;
                case 'PROPERTIES':  rawProperties.push(parseOneProperty(r)); break;
                // CUSTOM: each j iteration = one custom data type
                case 'CUSTOM':      rawCustom.push(parseOneCustom(r));       break;
                default:
                    console.warn(`[XScript] Unknown section '${hdr.name}' at offset ${r.offset}`);
                    i = root.count; j = hdr.count; // stop parsing
                    break;
            }
        }
    }

    // ── Build type maps ───────────────────────────────────────────────────────

    const dtMap       = buildDtToTs(rawDataTypes);
    const pardefTsMap = buildPardefTsMap(rawParDefs, dtMap);

    function getPardefTs(id: number): string { return pardefTsMap.get(id) ?? 'any'; }

    function refCodesToTypes(ids: number[]): string[] {
        return ids.map(id => {
            const dt = rawDataTypes.find(d => d.id === id);
            return dt ? dt.code.toUpperCase() : `DATATYPE_${id}`;
        });
    }

    // ── Convert raw function → XFunction ─────────────────────────────────────

    const globalFuncNames = new Set(rawGFuncs.map(f => f.name));
    const objectFuncNames = new Set(rawOFuncs.map(f => f.name));

    function convertFunction(raw: RawFunction): XFunction {
        const refs   = refCodesToTypes(raw.refObjTypeIds);
        const rstyle = retVarTypeToStyle(raw.returnVarType);
        const rdtId  = raw.returnValueTypeIds[0];
        const rdtype = rdtId !== undefined ? (dtMap.get(rdtId) ?? null) : null;

        let scope: XFunction['scope'] = 'global';
        if (refs.length > 0) {
            if      (refs.includes('DATATYPE_SHIP'))    { scope = 'ship'; }
            else if (refs.includes('DATATYPE_STATION')) { scope = 'station'; }
            else if (refs.includes('DATATYPE_SECTOR'))  { scope = 'sector'; }
            else if (refs.includes('DATATYPE_OBJECT'))  { scope = 'object'; }
            else if (refs.includes('DATATYPE_RACE'))    { scope = 'race'; }
        } else if (objectFuncNames.has(raw.name) && !globalFuncNames.has(raw.name)) {
            scope = 'object';
        }

        const args = raw.fnArgs.map((a: RawArgument, i: number) => ({
            pardef:      String(a.pardefId),
            description: a.desc,
            tsType:      getPardefTs(a.pardefId),
            paramName:   makeParamName(String(a.pardefId), a.desc, i),
        }));

        return {
            id: raw.id, name: raw.name, description: raw.desc,
            refTypes: refs, returnStyle: rstyle, returnType: rdtype,
            returnTs: retTs(rstyle, rdtype), args, example: raw.example, scope,
        };
    }

    // ── Assemble XDatabase ────────────────────────────────────────────────────

    const functions       = new Map<number, XFunction>();
    const byName          = new Map<string, XFunction[]>();
    const shipFunctions:    XFunction[] = [];
    const stationFunctions: XFunction[] = [];
    const sectorFunctions:  XFunction[] = [];
    const objectFunctions:  XFunction[] = [];
    const raceFunctions:    XFunction[] = [];
    const globalFunctions:  XFunction[] = [];

    function addFunc(xf: XFunction): void {
        functions.set(xf.id, xf);
        if (!byName.has(xf.name)) { byName.set(xf.name, []); }
        byName.get(xf.name)!.push(xf);
        const refs = xf.refTypes;
        if (refs.length === 0) {
            globalFunctions.push(xf);
        } else {
            if (refs.includes('DATATYPE_SHIP'))    { shipFunctions.push(xf); }
            if (refs.includes('DATATYPE_STATION')) { stationFunctions.push(xf); }
            if (refs.includes('DATATYPE_SECTOR'))  { sectorFunctions.push(xf); }
            if (refs.includes('DATATYPE_OBJECT'))  { objectFunctions.push(xf); }
            if (refs.includes('DATATYPE_RACE'))    { raceFunctions.push(xf); }
        }
    }

    for (const raw of rawGFuncs) { addFunc(convertFunction(raw)); }
    for (const raw of rawOFuncs) { addFunc(convertFunction(raw)); }

    // Properties
    const properties: XProperty[] = rawProperties.map(p => {
        const gFn = functions.get(p.getterId);
        return {
            name: p.name, description: p.desc,
            getterId: p.getterId,
            setterId: p.setterId || null,
            tsType:   gFn ? gFn.returnTs : 'any',
            readonly: p.setterId === 0,
        };
    });

    // Constants
    const constants: XConstant[] = [];

    for (const c of rawConstants) {
        if (c.code) { constants.push({ code: c.code, description: '', type: '' }); }
    }
    for (const [ns, entries] of rawConstNS) {
        for (const e of entries) {
            constants.push({ code: `${ns}.${e.code}`, description: e.groupName, type: ns });
        }
    }
    for (const race of rawRaces) {
        constants.push({ code: race.code, description: race.name, type: 'Race' });
    }
    for (const ware of rawWares) {
        constants.push({ code: ware.code, description: ware.name, type: 'Ware' });
    }
    for (const custom of rawCustom) {
        for (const e of custom.entries) {
            constants.push({ code: e.code, description: e.desc, type: custom.name });
        }
    }
    for (const cmdList of rawCmdLists) {
        for (const [, cmd] of cmdList.commands) {
            constants.push({ code: cmd.id, description: cmd.description, type: 'Command' });
        }
    }

    return {
        functions, byName, properties, constants,
        shipFunctions, stationFunctions, sectorFunctions,
        objectFunctions, raceFunctions, globalFunctions,
    };
}

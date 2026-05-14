import * as path from 'path';
import * as fs from 'fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FunctionArg {
    pardef: string;
    description: string;
    tsType: string;
    paramName: string;
}

export interface XFunction {
    id: number;
    name: string;
    description: string;
    /** DATATYPE_SHIP, DATATYPE_STATION, DATATYPE_SECTOR, DATATYPE_OBJECT, DATATYPE_RACE, or [] */
    refTypes: string[];
    returnStyle: 'return' | 'if' | 'no_if' | 'start' | null;
    returnType: string | null;
    returnTs: string;
    args: FunctionArg[];
    example: string;
    /** Which interface this belongs to: 'ship'|'station'|'sector'|'object'|'race'|'global' */
    scope: 'ship' | 'station' | 'sector' | 'object' | 'race' | 'global';
}

export interface XProperty {
    name: string;
    description: string;
    getterId: number;
    setterId: number | null;
    tsType: string;
    readonly: boolean;
}

export interface XConstant {
    code: string;
    description: string;
    type: string;
}

export interface XDatabase {
    functions: Map<number, XFunction>;
    /** Lookup by name — multiple overloads possible */
    byName: Map<string, XFunction[]>;
    properties: XProperty[];
    constants: XConstant[];
    /** Ship methods */
    shipFunctions: XFunction[];
    /** Station methods */
    stationFunctions: XFunction[];
    /** Sector methods */
    sectorFunctions: XFunction[];
    /** XObject methods */
    objectFunctions: XFunction[];
    /** Race methods */
    raceFunctions: XFunction[];
    /** Global functions */
    globalFunctions: XFunction[];
}

// ── Pardef → TypeScript type ──────────────────────────────────────────────────

const PARDEF_TS: Record<string, string> = {
    'VALUE': 'any', 'NUMBER': 'number', '11': 'string', 'VARBOOLEAN': 'boolean',
    'RACE': 'Race', 'WARE': 'Ware', 'VARSECTOR': 'Sector',
    'STATIONTYPE': 'StationType', 'SHIPTYPE': 'ShipType',
    'SHIPSTATIONTYPE': 'ShipType | StationType',
    'STATIONSHIP': 'Ship | Station', 'OBJECTCLASS': 'number',
    'ARRAY': 'any[]', 'ARRAYTABLE': 'any[] | Record<any, any>',
    'TABLE': 'Record<any, any>', '74': 'Record<any, any>', '29': 'Record<any, any>',
    '7': 'string', '12': 'Station', '21': 'Ship', '22': 'Ship | Station',
    'LASER': 'number', 'SHIELD': 'number', '83': 'number', '82': 'number',
    'RELATION': 'number', 'STATIONSERIAL': 'string',
    '89': 'number', '65': 'number', '88': 'number', '72': 'AgentCommand',
    '66': 'Passenger', 'CALLNAME': 'string', 'VARSTRING': 'string',
    'WINGCMD': 'number', 'OBJCMD': 'number',
};

const DTYPE_TS: Record<string, string> = {
    'DATATYPE_INT': 'number', 'DATATYPE_STRING': 'string',
    'DATATYPE_ARRAY': 'any[]', 'DATATYPE_SHIP': 'Ship',
    'DATATYPE_STATION': 'Station', 'DATATYPE_SECTOR': 'Sector',
    'DATATYPE_OBJECT': 'XObject', 'DATATYPE_RACE': 'Race',
    'DATATYPE_WARE': 'Ware', 'VALUE': 'any',
    '29': 'Record<any, any>', '74': 'Record<any, any>',
    '28': 'AgentCommand', '18': 'number', '5': 'string',
};

export function pardefToTs(pardef: string): string {
    return PARDEF_TS[pardef] ?? 'any';
}

export function dtypeToTs(dtype: string | null): string {
    if (!dtype) { return 'void'; }
    return DTYPE_TS[dtype] ?? 'any';
}

export function retTs(style: string | null, dtype: string | null): string {
    const t = dtype ? dtypeToTs(dtype) : 'any';
    if (style === 'return' || style === 'start') { return t; }
    if (style === 'if' || style === 'no_if')     { return `${t} | false`; }
    return 'void';
}

// ── Param name derivation ─────────────────────────────────────────────────────

const STRIP_LEAD = /^(true|false|the|a|an|if|whether|enable|disable|pass)\s+/gi;
const STRIP_TRAIL = /\s*(to\s+\w+|\([^)]*\))\s*$/i;
const FALLBACKS: Record<string, string> = {
    'RACE': 'race', 'WARE': 'ware', 'NUMBER': 'value', 'VARBOOLEAN': 'enabled',
    'VARSECTOR': 'sector', '11': 'text', 'ARRAY': 'arr', 'TABLE': 'table',
    'SHIPTYPE': 'shipType', 'STATIONTYPE': 'stationType',
    '12': 'station', '21': 'ship', 'VALUE': 'value',
};

export function makeParamName(pardef: string, desc: string, idx: number): string {
    let d = desc.trim().replace(/[^a-zA-Z0-9 ]/g, ' ');
    d = d.replace(STRIP_LEAD, '').replace(STRIP_TRAIL, '');
    const words = d.split(/\s+/).filter(Boolean).slice(0, 4);
    if (words.length > 0) {
        const name = words[0][0].toLowerCase() + words[0].slice(1)
            + words.slice(1, 3).map(w => w[0].toUpperCase() + w.slice(1)).join('');
        const clean = name.replace(/[^a-zA-Z0-9_$]/g, '');
        if (clean && !/^\d/.test(clean) && !['in', 'for', 'if', 'do', 'new', 'var', 'let', 'function'].includes(clean)) {
            return clean;
        }
    }
    return FALLBACKS[pardef] ?? `arg${idx}`;
}

// ── Regex-based XML parser (no DOM dependency) ────────────────────────────────

function attr(tag: string, name: string): string {
    const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(tag);
    return m ? m[1] : '';
}

function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
    const results: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    while ((m = re.exec(text)) !== null) { results.push(m); }
    return results;
}

export function parseXml(xmlPath: string): XDatabase {
    const xml = fs.readFileSync(xmlPath, 'utf-8');

    const functions = new Map<number, XFunction>();
    const byName    = new Map<string, XFunction[]>();
    const properties: XProperty[] = [];
    const constants: XConstant[]  = [];

    // ── Parse functions ──────────────────────────────────────────────────────

    const funcRe = /<Function id="(\d+)"[^>]*name="([^"]*)"[^>]*description="([^"]*)"[^>]*>([\s\S]*?)<\/Function>/g;
    let fm: RegExpExecArray | null;

    while ((fm = funcRe.exec(xml)) !== null) {
        const fid  = parseInt(fm[1]);
        const name = fm[2];
        const desc = fm[3];
        const body = fm[4];

        // RefObjectTypes
        const refTypes = allMatches(/<RefObjectType>([^<]+)<\/RefObjectType>/g, body)
            .map(m => m[1].trim());

        // ReturnValue
        let returnStyle: XFunction['returnStyle'] = null;
        let returnType: string | null = null;
        const rvOuter = /<ReturnValue type="([^"]+)">([\s\S]*?)<\/ReturnValue>/g.exec(body);
        if (rvOuter) {
            returnStyle = rvOuter[1] as XFunction['returnStyle'];
            const inner = /<ReturnValue>([^<]+)<\/ReturnValue>/g.exec(rvOuter[2]);
            if (inner) { returnType = inner[1].trim(); }
        }

        // Arguments
        const args: FunctionArg[] = [];
        const argRe = /<Argument pardef="([^"]+)"\s+description="([^"]*)"/g;
        let am: RegExpExecArray | null;
        while ((am = argRe.exec(body)) !== null) {
            const pardef = am[1];
            const argDesc = am[2];
            args.push({
                pardef,
                description: argDesc,
                tsType:      pardefToTs(pardef),
                paramName:   makeParamName(pardef, argDesc, args.length),
            });
        }

        // Example
        const exampleM = /<Example>([^<]*)<\/Example>/i.exec(body);
        const example = exampleM ? exampleM[1].trim() : '';

        // Scope
        let scope: XFunction['scope'] = 'global';
        if (refTypes.length > 0) {
            if      (refTypes.includes('DATATYPE_SHIP'))    { scope = 'ship'; }
            else if (refTypes.includes('DATATYPE_STATION')) { scope = 'station'; }
            else if (refTypes.includes('DATATYPE_SECTOR'))  { scope = 'sector'; }
            else if (refTypes.includes('DATATYPE_OBJECT'))  { scope = 'object'; }
            else if (refTypes.includes('DATATYPE_RACE'))    { scope = 'race'; }
            else { scope = 'global'; }
        }
        // Multi-ref: prefer most-specific
        if (refTypes.includes('DATATYPE_SHIP') && refTypes.includes('DATATYPE_STATION')) {
            scope = 'ship'; // will be added to both via byName
        }

        const fn: XFunction = {
            id: fid, name, description: desc, refTypes,
            returnStyle, returnType,
            returnTs: retTs(returnStyle, returnType),
            args, example, scope,
        };

        functions.set(fid, fn);

        if (!byName.has(name)) { byName.set(name, []); }
        byName.get(name)!.push(fn);
    }

    // ── Parse properties ─────────────────────────────────────────────────────

    const propRe = /<Property name="([^"]+)"\s+description="([^"]*)"\s+getter="(\d+)"(?:\s+setter="(\d+)")?/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(xml)) !== null) {
        const getterId = parseInt(pm[3]);
        const gFn = functions.get(getterId);
        const tsType = gFn ? gFn.returnTs : 'any';
        const setterId = pm[4] ? parseInt(pm[4]) : null;
        properties.push({
            name: pm[1], description: pm[2],
            getterId, setterId, tsType,
            readonly: setterId === null,
        });
    }

    // ── Parse constants ───────────────────────────────────────────────────────

    const constRe = /<Constant[^>]+code="([^"]+)"[^>]+description="([^"]*)"[^>]+type="([^"]*)"/g;
    let cm: RegExpExecArray | null;
    while ((cm = constRe.exec(xml)) !== null) {
        constants.push({ code: cm[1], description: cm[2], type: cm[3] });
    }

    // ── Build scoped lists ────────────────────────────────────────────────────

    const shipFunctions:    XFunction[] = [];
    const stationFunctions: XFunction[] = [];
    const sectorFunctions:  XFunction[] = [];
    const objectFunctions:  XFunction[] = [];
    const raceFunctions:    XFunction[] = [];
    const globalFunctions:  XFunction[] = [];

    for (const fn of functions.values()) {
        const refs = fn.refTypes;
        if (refs.length === 0) {
            globalFunctions.push(fn);
        } else {
            if (refs.includes('DATATYPE_SHIP'))    { shipFunctions.push(fn); }
            if (refs.includes('DATATYPE_STATION')) { stationFunctions.push(fn); }
            if (refs.includes('DATATYPE_SECTOR'))  { sectorFunctions.push(fn); }
            if (refs.includes('DATATYPE_OBJECT'))  { objectFunctions.push(fn); }
            if (refs.includes('DATATYPE_RACE'))    { raceFunctions.push(fn); }
        }
    }

    return {
        functions, byName, properties, constants,
        shipFunctions, stationFunctions, sectorFunctions,
        objectFunctions, raceFunctions, globalFunctions,
    };
}

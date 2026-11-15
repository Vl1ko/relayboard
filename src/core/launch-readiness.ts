/** Read-only release verification must reject missing, changed and newer migrations. */
export function migrationReadinessBlockers(applied: {version:number;checksum:string}[], expected:{version:number;checksum:string}[]) {
 const blockers:string[]=[];
 for(const wanted of expected){const actual=applied.find(row=>row.version===wanted.version);if(!actual)blockers.push('Missing AI migration '+wanted.version);else if(actual.checksum!==wanted.checksum)blockers.push('AI migration checksum mismatch '+wanted.version);}
 for(const row of applied)if(!expected.some(wanted=>wanted.version===row.version))blockers.push('Database has a newer or unrecognized AI migration '+row.version);
 return blockers;
}

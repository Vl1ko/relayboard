import {readFile} from 'node:fs/promises';import {X509Certificate} from 'node:crypto';
const pem=await readFile(new URL('../certs/gigachat-root-ca.pem',import.meta.url),'utf8');
if(!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/u.test(pem.trim()))throw Error('Only the single pinned public GigaChat CA is allowed');
const certificate=new X509Certificate(pem);
const expected='D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31';
if(certificate.fingerprint256.replaceAll(':','')!==expected||!certificate.ca||!certificate.verify(certificate.publicKey)||Date.now()<Date.parse(certificate.validFrom)||Date.now()>=Date.parse(certificate.validTo))throw Error('GigaChat CA verification failed; review the official certificate before building');
console.log('Verified pinned public GigaChat CA; TLS verification remains enabled');

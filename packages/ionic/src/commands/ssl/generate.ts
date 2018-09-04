import * as path from 'path';

import chalk from 'chalk';
import * as lodash from 'lodash';

import { CommandGroup, OptionGroup } from '@ionic/cli-framework';
import { prettyPath } from '@ionic/cli-framework/utils/format';
import { fsMkdirp, fsUnlink, fsWriteFile, pathExists, tmpfilepath } from '@ionic/utils-fs';

import { CommandLineInputs, CommandLineOptions, CommandMetadata, CommandPreRun } from '@ionic/cli-utils';
import { FatalException } from '@ionic/cli-utils/lib/errors';

import { SSLBaseCommand } from './base';

const DEFAULT_BITS = '2048';
const DEFAULT_COUNTRY_NAME = 'US';
const DEFAULT_STATE_OR_PROVINCE_NAME = 'Wisconsin';
const DEFAULT_LOCALITY_NAME = 'Madison';
const DEFAULT_ORGANIZATION_NAME = 'Ionic';
const DEFAULT_COMMON_NAME = 'localhost';

interface OpenSSLConfig {
  bits: string;
  countryName: string;
  stateOrProvinceName: string;
  localityName: string;
  organizationName: string;
  commonName: string;
}

const DEFAULT_KEY_FILE = '.ionic/ssl/key.pem';
const DEFAULT_CERT_FILE = '.ionic/ssl/cert.pem';

export class SSLGenerateCommand extends SSLBaseCommand implements CommandPreRun {
  getDefaultKeyPath() {
    return path.resolve(this.project ? this.project.directory : '', DEFAULT_KEY_FILE);
  }

  getDefaultCertPath() {
    return path.resolve(this.project ? this.project.directory : '', DEFAULT_CERT_FILE);
  }

  async getMetadata(): Promise<CommandMetadata> {
    const defaultKeyPath = prettyPath(this.getDefaultKeyPath());
    const defaultCertPath = prettyPath(this.getDefaultCertPath());

    return {
      name: 'generate',
      type: 'project',
      summary: 'Generates an SSL key & certificate',
      // TODO: document how to add trusted certs
      description: `
Uses OpenSSL to create a self-signed certificate for ${chalk.bold('localhost')} (by default).

After the certificate is generated, you will still need to add it to your system or browser as a trusted certificate.

The default directory for ${chalk.green('--key-path')} and ${chalk.green('--cert-path')} is ${chalk.green('.ionic/ssl/')}.
      `,
      options: [
        {
          name: 'key-path',
          summary: 'Destination of private key file',
          default: defaultKeyPath,
        },
        {
          name: 'cert-path',
          summary: 'Destination of certificate file',
          default: defaultCertPath,
        },
        {
          name: 'country-name',
          summary: 'The country name (C) of the SSL certificate',
          default: DEFAULT_COUNTRY_NAME,
          groups: [OptionGroup.Advanced],
        },
        {
          name: 'state-or-province-name',
          summary: 'The state or province name (ST) of the SSL certificate',
          default: DEFAULT_STATE_OR_PROVINCE_NAME,
          groups: [OptionGroup.Advanced],
        },
        {
          name: 'locality-name',
          summary: 'The locality name (L) of the SSL certificate',
          default: DEFAULT_LOCALITY_NAME,
          groups: [OptionGroup.Advanced],
        },
        {
          name: 'organization-name',
          summary: 'The organization name (O) of the SSL certificate',
          default: DEFAULT_ORGANIZATION_NAME,
          groups: [OptionGroup.Advanced],
        },
        {
          name: 'common-name',
          summary: 'The common name (CN) of the SSL certificate',
          default: DEFAULT_COMMON_NAME,
          groups: [OptionGroup.Advanced],
        },
        {
          name: 'bits',
          summary: 'Number of bits in the key',
          aliases: ['b'],
          default: DEFAULT_BITS,
          groups: [OptionGroup.Advanced],
        },
      ],
      groups: [CommandGroup.Experimental],
    };
  }

  async preRun(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    await this.checkForOpenSSL();
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    if (!this.project) {
      throw new FatalException(`Cannot run ${chalk.green('ionic ssl generate')} outside a project directory.`);
    }

    const keyPath = path.resolve(options['key-path'] ? String(options['key-path']) : this.getDefaultKeyPath());
    const keyPathDir = path.dirname(keyPath);
    const certPath = path.resolve(options['cert-path'] ? String(options['cert-path']) : this.getDefaultCertPath());
    const certPathDir = path.dirname(certPath);

    const bits = options['bits'] ? String(options['bits']) : DEFAULT_BITS;
    const countryName = options['country-name'] ? String(options['country-name']) : DEFAULT_COUNTRY_NAME;
    const stateOrProvinceName = options['state-or-province-name'] ? String(options['state-or-province-name']) : DEFAULT_STATE_OR_PROVINCE_NAME;
    const localityName = options['locality-name'] ? String(options['locality-name']) : DEFAULT_LOCALITY_NAME;
    const organizationName = options['organization-name'] ? String(options['organization-name']) : DEFAULT_ORGANIZATION_NAME;
    const commonName = options['common-name'] ? String(options['common-name']) : DEFAULT_COMMON_NAME;

    await this.ensureDirectory(keyPathDir);
    await this.ensureDirectory(certPathDir);

    const overwriteKeyPath = await this.checkExistingFile(keyPath);
    const overwriteCertPath = await this.checkExistingFile(certPath);

    if (overwriteKeyPath) {
      await fsUnlink(keyPath);
    }

    if (overwriteCertPath) {
      await fsUnlink(certPath);
    }

    const cnf = { bits, countryName, stateOrProvinceName, localityName, organizationName, commonName };
    const cnfPath = await this.writeConfig(cnf);

    await this.env.shell.run('openssl', ['req', '-x509', '-newkey', `rsa:${bits}`, '-nodes', '-subj', this.formatSubj(cnf), '-reqexts', 'SAN', '-extensions', 'SAN', '-config', cnfPath, '-days', '365', '-keyout', keyPath, '-out', certPath], {});

    this.env.log.nl();

    this.env.log.rawmsg(
      `Key:  ${chalk.bold(prettyPath(keyPath))}\n` +
      `Cert: ${chalk.bold(prettyPath(certPath))}\n\n`
    );

    this.env.log.ok('Generated key & certificate!');
  }

  private formatSubj(cnf: OpenSSLConfig) {
    const subjNames = new Map([
      ['countryName', 'C'],
      ['stateOrProvinceName', 'ST'],
      ['localityName', 'L'],
      ['organizationName', 'O'],
      ['commonName', 'CN'],
    ]);

    return '/' + lodash.toPairs(cnf).filter(([k]) => subjNames.has(k)).map(([k, v]) => `${subjNames.get(k)}=${v}`).join('/');
  }

  private async ensureDirectory(p: string) {
    if (!(await pathExists(p))) {
      await fsMkdirp(p, 0o700);
      this.env.log.msg(`Created ${chalk.bold(prettyPath(p))} directory for you.`);
    }
  }

  private async checkExistingFile(p: string): Promise<boolean | undefined> {
    if (await pathExists(p)) {
      const confirm = await this.env.prompt({
        type: 'confirm',
        name: 'confirm',
        message: `Key ${chalk.bold(prettyPath(p))} exists. Overwrite?`,
      });

      if (confirm) {
        return true;
      } else {
        throw new FatalException(`Not overwriting ${chalk.bold(prettyPath(p))}.`);
      }
    }
  }

  private async writeConfig({ bits, countryName, stateOrProvinceName, localityName, organizationName, commonName }: OpenSSLConfig): Promise<string> {
    const cnf = `
[req]
default_bits       = ${bits}
distinguished_name = req_distinguished_name

[req_distinguished_name]
countryName                = ${countryName}
stateOrProvinceName        = ${stateOrProvinceName}
localityName               = ${localityName}
organizationName           = ${organizationName}
commonName                 = ${commonName}

[SAN]
subjectAltName=DNS:${commonName}
`.trim();

    const p = tmpfilepath('ionic-ssl');
    await fsWriteFile(p, cnf, { encoding: 'utf8' });
    return p;
  }
}

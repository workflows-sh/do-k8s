import { Construct } from 'constructs';
import { TerraformStack, RemoteBackend, Fn, TerraformIterator } from 'cdktf';
import { sdk } from '@cto.ai/sdk';
import YAML from 'yaml';
import { KubectlProvider } from '../../.gen/providers/kubectl/provider'
import { Manifest } from '../../.gen/providers/kubectl/manifest'
import { DigitaloceanProvider } from '../../.gen/providers/digitalocean/provider';
import { Exec, pexec } from '../utils'

interface StackProps {
    cluster: any
    org: string
    env: string
}

export default class Dora extends TerraformStack {
    public readonly id: string
    public readonly org: string | undefined
    public readonly env: string
    public readonly props: StackProps | undefined

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id)
        this.props = props
        this.org = props?.org ?? 'cto-ai'
        this.id = id
        this.env = props?.env ?? 'dev'

        new DigitaloceanProvider(this, `${this.id}-provider`, {
            token: process.env.DO_TOKEN,
            spacesAccessId: process.env.DO_SPACES_ACCESS_KEY_ID,
            spacesSecretKey: process.env.DO_SPACES_SECRET_ACCESS_KEY
        })

        new RemoteBackend(this, {
            hostname: 'app.terraform.io',
            organization: process.env.TFC_ORG || this.org,
            workspaces: {
                name: this.id
            }
        })
    }
    async initialize() {
        
        const doraRemoteRegUser = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_REMOTE_REG_USERNAME`) || '';
        const doraRemoteRegPass = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_REMOTE_REG_PASSWORD`) || '';
        const doraAuthTeam = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_AUTH_TEAM`) || '';
        const doraAuthToken = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_AUTH_TOKEN`) || '';
        const doraControllerReleaseTag = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_CONTROLLER_RELEASE_TAG`) || '';
        const doraControllerRepo = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_CONTROLLER_REPO`) || '';
        const doraWriterReleaseTag = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_WRITER_RELEASE_TAG`) || '';
        const doraWriterRepo = await sdk.getConfig(`DO_${this.env.toUpperCase()}_DORA_WRITER_REPO`) || '';


        const notInitialize = doraRemoteRegUser == "" ||
        doraRemoteRegPass == "" ||
        doraAuthTeam == "" ||
        doraAuthToken == "" ||
        doraControllerReleaseTag == "" ||
        doraControllerRepo == "" ||
        doraWriterReleaseTag == "" ||
        doraWriterRepo == "" ;
        if(!notInitialize){
            this.doraInit(
                doraRemoteRegUser,
                doraRemoteRegPass,
                doraAuthTeam,
                doraAuthToken,
                doraControllerReleaseTag,
                doraControllerRepo,
                doraWriterReleaseTag,
                doraWriterRepo
            );
        }
    }

    async doraInit(
        doraRemoteRegUser: string,
        doraRemoteRegPass: string,
        doraAuthTeam: string,
        doraAuthToken: string,
        doraControllerReleaseTag: string,
        doraControllerRepo: string,
        doraWriterReleaseTag: string,
        doraWriterRepo: string
    ) {


        new KubectlProvider(this, `${this.id}-kubectl-provider`, {
            host: this.props?.cluster?.cluster?.endpoint,
            configPath: '/home/ops/.kube/config',
            loadConfigFile: true,
        })

        // install dora controller
        const ghAuthCmd = `echo ${doraRemoteRegPass} | gh auth login --with-token`
        await Exec(ghAuthCmd)
            .catch(err => { throw err })

        const namespace = 'dora-controller-system'
        const secretName = `${this.id}-image-secret`

        const doraCtlYmlCmd = `gh release download ${doraControllerReleaseTag} -R ${doraControllerRepo} -p 'install.yaml' -O -`
        const doraCtlYml = await this.getYaml(doraCtlYmlCmd)
            .catch(err => { throw err })

        if (doraCtlYml !== undefined) {
            const manifests = this.setDeployImgSecret(doraCtlYml, 'dora-controller-manager', secretName)
            this.deployManifests(manifests, 'dora-controller', namespace)
        }

        // add image pull secret to cluster
        const imgPullSecretYmlCmd = `kubectl create secret docker-registry ${secretName} --docker-username=${doraRemoteRegUser} --docker-password=${doraRemoteRegPass} --docker-server=ghcr.io -n ${namespace} --dry-run=client -o yaml`
        const imgPullSecretYml = await this.getYaml(imgPullSecretYmlCmd)
            .catch(err => { throw err })
        if (imgPullSecretYml !== undefined) {
            const sensitiveFields = ["data.\.dockerconfigjson"]
            this.deployManifests(imgPullSecretYml, 'dora-controller-image-pull-secret', namespace, sensitiveFields)
        }

        // install dora metric writer
        const doraWriterSecretYmlCmd = `kubectl create secret generic cto-client-auth --from-literal=AUTH_TEAM=${doraAuthTeam} --from-literal=AUTH_TOKEN=${doraAuthToken} -n ${namespace} --dry-run=client -o yaml`
        const doraWriterSecretYml = await this.getYaml(doraWriterSecretYmlCmd)
            .catch(err => { throw err })
        if (doraWriterSecretYml !== undefined) {
            const sensitiveFields = ["data.AUTH_TEAM", "data.AUTH_TOKEN"]
            this.deployManifests(doraWriterSecretYml, 'dora-writer-image-secret', namespace, sensitiveFields)
        }

        const doraWriterYmlCmd = `gh release download ${doraWriterReleaseTag} -R ${doraWriterRepo} -p 'install.yaml' -O -`
        const doraWriterYml = await this.getYaml(doraWriterYmlCmd)
            .catch(err => { throw err })
        if (doraWriterYml !== undefined) {
            const manifests = this.setDeployImgSecret(doraWriterYml, 'workflows-sh-dora-writer', secretName)
            this.deployManifests(manifests, 'workflows-sh-dora-writer', namespace)
        }

        sdk.log('dora controller and writer deployed')
    }

    private async getYaml(ymlCmd: string): Promise<any[] | undefined> {
        try {
            const ymlCmdRes = await pexec(ymlCmd)
            const manifests: any[] = []
            for (let p of YAML.parseAllDocuments(ymlCmdRes.stdout)) {
                const obj = p.toJSON()
                manifests.push(obj)
            }
            return Promise.resolve(manifests)
        } catch (err) {
            return Promise.reject(err)
        }
    }

    private setDeployImgSecret(manifests: any[], deploymentName: string, imagePullSecretName: string): any[] {
        for (let manifest of manifests) {
            if (manifest['kind'] == 'Deployment' && manifest['metadata']['name'] == deploymentName) {
                manifest['spec']['template']['spec']['imagePullSecrets'] = [
                    {
                        name: imagePullSecretName
                    }
                ]
            }
        }
        return manifests
    }

    private deployManifests(manifests: any[], suffix: string, namespace: string, sensitiveFields: string[] = []) {
        // https://github.com/hashicorp/terraform/issues/23322
        // Due to this issue, we need to do additional processing for yaml content while converting back to string
        const yamls = manifests.map(m => Fn.rawString(YAML.stringify(m)))
        const iterator = TerraformIterator.fromList(yamls)
        new Manifest(this, `${this.id}-${suffix}`, {
            forEach: iterator,
            wait: true,
            yamlBody: iterator.value,
            overrideNamespace: namespace,
            sensitiveFields: sensitiveFields,
        })
    }
}
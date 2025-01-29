import { App } from "cdktf";
import Cluster from './cluster'
import Service from './service'
import Registry from './registry'
import Dora from "./dora";

interface StackProps {
  org: string
  env: string
  repo: string
  tag: string
  key: string
  entropy: string
  region: string
}

export class Stack {

  public readonly org: string
  public readonly env: string
  public readonly repo: string
  public readonly tag: string
  public readonly key: string
  public readonly entropy: string
  public readonly region: string

  constructor(props?: StackProps) {
    this.org = props?.org ?? 'cto-ai'
    this.env = props?.env ?? 'dev'
    this.key = props?.key ?? 'do-k8s-cdktf'
    this.repo = props?.repo ?? 'sample-expressjs-do-k8s-cdktf'
    this.tag = props?.tag ?? 'main'
    this.entropy = props?.entropy ?? '20220921'
    this.region = props?.region ?? 'SFO3'
  }

  async initialize() {

    const app = new App();

    const registry = new Registry(app, `registry-${this.key}`, {
      org: this.org,
      env: this.env,
      key: this.key,
      repo: this.repo,
      entropy: this.entropy,
      region: this.region
    })
    await registry.initialize()

    // create each vpc, cluster & db
    const cluster = new Cluster(app, `${this.env}-${this.key}`, {
      org: this.org,
      env: this.env,
      key: this.key,
      repo: this.repo,
      tag: this.tag,
      entropy: this.entropy
    })
    await cluster.initialize()

    const dora = new Dora(app, `${this.env}-dora-controller-${this.key}`,{
      org: this.org,
      cluster: cluster,
      env: this.env
    })
    await dora.initialize()

    const service = new Service(app, `${this.env}-${this.repo}-${this.key}`, {
      org: this.org,
      env: this.env,
      key: this.key,
      repo: this.repo,
      tag: this.tag,
      entropy: this.entropy,
      registry: registry,
      cluster: cluster
    })
    await service.initialize()

    app.synth()

  }
}

export default Stack

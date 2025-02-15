import IntegrationRepository from '../../database/repositories/integrationRepository'
import { PlatformType } from '../../types/integrationEnums'
import SequelizeRepository from '../../database/repositories/sequelizeRepository'
import IncomingWebhookRepository from '../../database/repositories/incomingWebhookRepository'
import { WebhookType } from '../../types/webhooks'
import { sendNodeWorkerMessage } from '../../serverless/utils/nodeWorkerSQS'
import { NodeWorkerProcessWebhookMessage } from '../../types/mq/nodeWorkerProcessWebhookMessage'

export default async (req, res) => {
  const signature = req.headers['x-hub-signature']
  const event = req.headers['x-github-event']
  const data = req.body

  const identifier = data.installation.id.toString()
  const integration = (await IntegrationRepository.findByIdentifier(
    identifier,
    PlatformType.GITHUB,
  )) as any

  if (integration) {
    req.log.info({ integrationId: integration.id }, 'Incoming GitHub Webhook!')
    const options = await SequelizeRepository.getDefaultIRepositoryOptions()
    const repo = new IncomingWebhookRepository(options)

    const result = await repo.create({
      tenantId: integration.tenantId,
      integrationId: integration.id,
      type: WebhookType.GITHUB,
      payload: {
        signature,
        event,
        data,
      },
    })

    await sendNodeWorkerMessage(
      integration.tenantId,
      new NodeWorkerProcessWebhookMessage(integration.tenantId, result.id),
    )

    await req.responseHandler.success(req, res, {}, 204)
  } else {
    req.log.error({ identifier }, 'No integration found for incoming GitHub Webhook!')
    await req.responseHandler.success(req, res, {}, 200)
  }
}

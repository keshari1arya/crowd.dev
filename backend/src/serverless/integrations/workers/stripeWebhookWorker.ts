import moment from 'moment'
import { Stripe } from 'stripe'
import { PLANS_CONFIG } from '../../../config'
import SequelizeRepository from '../../../database/repositories/sequelizeRepository'
import Plans from '../../../security/plans'
import { ApiWebsocketMessage } from '../../../types/mq/apiWebsocketMessage'
import { NodeWorkerMessageBase } from '../../../types/mq/nodeWorkerMessageBase'
import { createServiceChildLogger } from '../../../utils/logging'
import { createRedisClient } from '../../../utils/redis'
import RedisPubSubEmitter from '../../../utils/redis/pubSubEmitter'
import { timeout } from '../../../utils/timing'
import { NodeWorkerMessageType } from '../../types/workerTypes'
import { sendNodeWorkerMessage } from '../../utils/nodeWorkerSQS'

const log = createServiceChildLogger('stripeWebhookWorker')

const stripe = new Stripe(PLANS_CONFIG.stripeSecretKey, {
  apiVersion: '2022-08-01',
  typescript: true,
})

export default async function stripeWebhookWorker(req) {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, PLANS_CONFIG.stripWebhookSigningSecret)
    await sendNodeWorkerMessage(event.id, {
      type: NodeWorkerMessageType.NODE_MICROSERVICE,
      event,
      service: 'stripe-webhooks',
    } as NodeWorkerMessageBase)
  } catch (err) {
    log.error(`Webhook Error: ${err.message}`)
    return {
      status: 400,
    }
  }

  return {
    status: 200,
  }
}

export const processStripeWebhook = async (message: any) => {
  log.info({ message }, 'Got event from stripe webhook!')
  log.warn(message)

  const options = await SequelizeRepository.getDefaultIRepositoryOptions()
  const redis = await createRedisClient(true)

  const apiPubSubEmitter = new RedisPubSubEmitter('api-pubsub', redis, (err) => {
    log.error({ err }, 'Error in api-ws emitter!')
  })
  const stripeWebhookMessage = message.event

  switch (stripeWebhookMessage.type) {
    case 'checkout.session.completed': {
      log.info(
        { tenant: stripeWebhookMessage.data.object.client_reference_id },
        'Processing checkout.session.complete',
      )

      // get subscription information from checkout event
      const subscription = await stripe.subscriptions.retrieve(
        stripeWebhookMessage.data.object.subscription,
      )

      const subscriptionEndsAt = subscription.current_period_end
      const tenantId = stripeWebhookMessage.data.object.client_reference_id

      const tenant = await options.database.tenant.findByPk(tenantId)

      let productPlan

      if ((subscription as any).plan.product === PLANS_CONFIG.stripeEagleEyePlanProductId) {
        productPlan = Plans.values.eagleEye
      } else if ((subscription as any).plan.product === PLANS_CONFIG.stripeGrowthPlanProductId) {
        productPlan = Plans.values.growth
      } else {
        log.error({ subscription }, `Unknown product in subscription`)
        process.exit(1)
      }

      if (!tenant) {
        log.error({ tenantId }, 'Tenant not found!')
        process.exit(1)
      } else {
        log.info({ tenantId }, `Tenant found - updating tenant plan to ${productPlan} plan!`)
        await tenant.update({
          plan: productPlan,
          isTrialPlan: false,
          trialEndsAt: null,
          stripeSubscriptionId: stripeWebhookMessage.data.object.subscription,
          planSubscriptionEndsAt: moment(subscriptionEndsAt, 'X').toISOString(),
        })

        log.info('Emitting to redis pubsub for websocket forwarding from api..')

        // Wait few more seconds to ensure redirect is completed
        await timeout(3000)

        // Send websocket message to frontend
        apiPubSubEmitter.emit(
          'user',
          new ApiWebsocketMessage(
            'tenant-plan-upgraded',
            JSON.stringify({
              plan: productPlan,
              stripeSubscriptionId: stripeWebhookMessage.data.object.subscription,
            }),
            undefined,
            tenantId,
          ),
        )
        log.info('Done!')
      }

      break
    }
    case 'invoice.payment_succeeded': {
      // Since we're already updating the plan on session.completed event,
      // we only need to process this event when billing_reason = `subscription_cycle` for the recurring payments.
      // When subscription is newly created, billing_reason is `subscription_create`
      log.info(stripeWebhookMessage.data.object.billing_reason, 'Invoice payment event')

      if (stripeWebhookMessage.data.object.billing_reason === 'subscription_cycle') {
        // find tenant by stripeSubscriptionId
        const tenant = await options.database.tenant.findOne({
          where: { stripeSubscriptionId: stripeWebhookMessage.data.object.subscription },
        })

        const subscription = await stripe.subscriptions.retrieve(
          stripeWebhookMessage.data.object.subscription,
        )

        await tenant.update({
          planSubscriptionEndsAt: moment(subscription.current_period_end, 'X').toISOString(),
        })
      }

      break
    }
    default:
      log.info({ event: message.event }, 'Unsupported event')
  }
}

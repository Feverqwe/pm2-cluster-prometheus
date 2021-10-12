import * as pm2 from 'pm2';
import * as client from 'prom-client';

interface ProcessPacket {
  reqId: string,
  topic: string;
  id: number;
  data: any;
  isReply?: boolean;
  replyTo?: number;
  originalProcId: number;
  instanceId: string;
}

/**
 * This process's PM proc id
 */
const currentProcId = parseInt(process.env.pm_id, 10);

const instanceId = process.env[process.env.instance_var];

/**
 * Indicates the process is being ran in PM2's cluster mode
 */
export const isClusterMode = process.env.exec_mode === 'cluster_mode';

/**
 * Returns a list of PM2 processes when running in clustered mode
 */
function getProcList() {
  return new Promise<pm2.ProcessDescription[]>((resolve, reject) => {
    pm2.list((err, list) => {
      err ? reject(err)
        // only return processes with the same name
        : resolve(list.filter(o => o.name === process.env.name && o.pm2_env.status === 'online'));
    });
  });
}

/**
 * Broadcasts message to all processes in the cluster, resolving with the number of processes sent to
 */
async function broadcastToAll(packet: ProcessPacket): Promise<number> {
  return getProcList().then(list => {
    list.forEach(proc => pm2.sendDataToProcessId(proc.pm_id, packet, err => true));
    return list.length;
  });
}

/**
 * Sends a message to all processes in the cluster and resolves once all processes repsonsed or after a timeout
 */
async function awaitAllProcMessagesReplies(topic: string, timeoutInMilliseconds: number) {
  const reqId = Date.now() + '_' + Math.trunc(Math.random() * 1000000);
  const responses: ProcessPacket[] = [];

  const procLength = await broadcastToAll({
    reqId,
    id: currentProcId,
    replyTo: currentProcId,
    originalProcId: currentProcId,
    topic,
    data: {},
    isReply: false,
    instanceId,
  });

  return new Promise<typeof responses>(async (resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      process.removeListener('message', handler);
      reject(new Error('timeout'));
    }, timeoutInMilliseconds);

    const handler = (response: ProcessPacket) => {
      if (!response.isReply || response.topic !== topic || response.reqId !== reqId) {
        return;
      }

      responses.push(response);

      if (responses.length === procLength) {
        responses.sort((a, b) => a.instanceId > b.instanceId ? 1 : -1);
        process.removeListener('message', handler);
        clearTimeout(timeoutHandle);
        resolve(responses);
      }
    };

    process.on('message', handler);
  });
}

/**
 * Sends a reply to the processes which originated a broadcast
 */
function sendProcReply(originalPacket: ProcessPacket, data: any = {}) {
  const returnPacket = {
    ...originalPacket,
    data,
    isReply: true,
    id: currentProcId,
    originalProcId: currentProcId,
    instanceId
  };
  pm2.sendDataToProcessId(originalPacket.replyTo, returnPacket, err => true);
}

/**
 * Init
 */
if (isClusterMode) {
  const handleProcessMessage = async (packet: ProcessPacket) => {
    if (packet && packet.topic === 'metrics-get' && !packet.isReply) {
      try {
        sendProcReply(packet, await client.register.getMetricsAsJSON());
      } catch (err) {
        // pass
      }
    }
  };
  process.removeListener('message', handleProcessMessage);
  process.on('message', handleProcessMessage);
}

/**
 * Returns the aggregate metric if running in cluster mode, otherwise, just the current
 * instance's metrics
 */
export async function getAggregateRegister(timeoutInMilliseconds = 10e3) {
  if (isClusterMode) {
    const procMetrics = await awaitAllProcMessagesReplies('metrics-get', timeoutInMilliseconds);
    return client.AggregatorRegistry.aggregate(procMetrics.map(o => o.data));
  } else {
    return client.register;
  }
}


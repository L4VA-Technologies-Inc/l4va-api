import { Injectable } from "@nestjs/common";
import { Novu } from "@novu/api";

export interface INotificationBody {
  address: string;
  title: string;
  description: string;
}

@Injectable()
export class NotificationService {

  async sendNotification(body: INotificationBody) {
    const novu = new Novu({
      secretKey: process.env['NOVU_API_KEY']
    });

    try {
      const res = await novu.trigger({
        workflowId: 'l4va',
        to: body.address,
        payload: {
          title: body.title,
          description: body.description,
        }
      });
      return res;
    } catch (err) {
      return err;
    }
  }

}

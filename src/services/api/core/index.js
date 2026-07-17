import { CoreConfigProvider } from '@/services/api/core/config';
import { axiosInstance } from '@/services/api';

export class CoreApiProvider {
  static async login({ signature, stakeAddress, walletAddress, chainType }) {
    const response = await axiosInstance.post(CoreConfigProvider.login(), {
      signature,
      stakeAddress,
      walletAddress,
      chainType,
    });
    return response;
  }

  static async sendNotification(data) {
    const response = await axiosInstance.post(CoreConfigProvider.sendNotification(), data);
    return response;
  }

  static async getProfile() {
    const response = await axiosInstance.get(CoreConfigProvider.getProfile());
    return response;
  }

  static async getPublicProfile(userId) {
    return await axiosInstance.get(CoreConfigProvider.getPublicProfile(userId));
  }

  static async updateProfile(profileData) {
    const response = await axiosInstance.patch(CoreConfigProvider.updateProfile(), profileData);
    return response;
  }

  static async uploadImage(file, imageType = '') {
    const formData = new FormData();
    formData.append('image', file);

    if (imageType) formData.append('imageType', String(imageType));

    return await axiosInstance.post(CoreConfigProvider.uploadImage(), formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  static async uploadProfileImage(file, imageType = '') {
    const formData = new FormData();
    formData.append('image', file);

    if (imageType) formData.append('imageType', String(imageType));

    return await axiosInstance.post(CoreConfigProvider.uploadProfileImage(), formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  static async handleCsv(file) {
    const formData = new FormData();
    formData.append('csv', file);

    const response = await axiosInstance.post(CoreConfigProvider.handleCsv(), formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response;
  }

  static async acquireAda({ vaultId, assets }) {
    const response = await axiosInstance.post(CoreConfigProvider.acquire(vaultId), { assets });
    return response;
  }

  static async createContributionTx({ vaultId, assets }) {
    const response = await axiosInstance.post(CoreConfigProvider.createContributionTx(vaultId), {
      assets,
    });
    return response;
  }

  static async updateTransactionHash({ txId, txHash }) {
    const response = await axiosInstance.patch(CoreConfigProvider.updateTransactionHash(txId), {
      txHash,
    });
    return response;
  }
}

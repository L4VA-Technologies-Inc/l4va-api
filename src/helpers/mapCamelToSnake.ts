export const mapCamelToSnake =(data: any): any => {
  const mappedData = {};
  for (const key in data) {
    if (data.hasOwnProperty(key)) {
      const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      mappedData[snakeKey] = data[key];
    }
  }
  return mappedData;
};
